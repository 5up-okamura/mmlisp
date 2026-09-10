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
import { generate, CSM_TEST_VOICE, CSM_TEST_FREQ } from "./gen-stream.mjs";
import { tourBytes } from "./tour.mjs";
import { psgStream } from "./psg-stream.mjs";
import { lutPages } from "./lut.mjs";
import { generateObserver, PUBLISH_FAULTS, STATE } from "./observer.mjs";
import { generateSplit, SPLIT_STATE } from "./decode-split.mjs";
import { protocolLayout, protoGlobals, mailboxLayout, SNAPSHOT_BYTES,
  SNAPSHOT_STRIDE, MAILBOX, MAILBOX_BYTES } from "./protocol.mjs";
import { GLOB } from "./config.mjs";

// R21 §50.4: the three ways the adaptive choice can be broken. The first two
// are the fixed leads R20 measured, put back as faults so the sweep cannot
// quietly become one of them again; the third puts both comparison bytes out of
// reach so every attempt has to refuse.
export const PICK_FAULTS = {
  "pick-near": "the host always names R+2, whatever the live counter says",
  "pick-far": "the host always names R+3, whatever the live counter says",
  "count-astray": "the two candidate bytes are moved out of reach, so no counter can match",
};

// R22 §52.4's negative. The counter goes back behind `mb pending`, which is
// where R21 measured 44 late bundles in 3,675 — and the instruction-order check
// that now refuses that image is told to report rather than refuse, so the
// machine can be shown being late on it.
export const ORDER_FAULTS = {
  "counter-late": "the decode's counter is stored after the consumer has read the box",
};

export const QUEUE_FAULTS = {
  "q-commit-first": "commandCommit is bumped before the payload it stands for is written",
  "q-short-payload": "the commit claims a whole bundle and one byte of it never arrived",
};

export const FAULTS = {
  // R20 §48.3: the withdrawn transfer, kept only as a thing that must fail.
  // The emitter refuses to encode a wide access to Z80 RAM, so this fault is
  // the only place one can still be built — and the machine has to see the
  // duplicate byte it produces.
  "wide-read": "the host reads the published face with word moves, which the 8-bit Z80 bus duplicates",
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
  ...PICK_FAULTS,
  ...ORDER_FAULTS,
};

/**
 * @param c0    a case from the table
 * @param opts  {compensation, captureOffset, fault} — the CLI's overrides
 * @returns {case, cfg, gen, coop} with the case fully resolved
 */
// ONE MAILBOX PAYLOAD, in the wire format R17 §43.3 fixes: the observation its
// lap boundary is, then the three level pages. Five bytes at a fixed address —
// there is no cursor, no size and no type, because there is only ever one.
export const QREC_BYTES = MAILBOX_BYTES;
export const QREC_RECORD = [0x40, 0x00, 0xde, 0xad, 0xbe];

/**
 * The addresses the 68000's ROM needs, taken from the ONE layout (R12 §33.2).
 * They are OFFSETS from the Z80's base, because that is how the host addresses
 * Z80 RAM, and nothing here re-derives one.
 */
// WHICH PAGE IS LEVEL ZERO. The mixer's page number is an absolute Z80 page and
// the level family does not start at 0 — in the 15-level profile it is
// $0C00..$1B00, so page 12 is silence and page 26 is unity. A host staging
// 0..14 is staging the code region as a volume table, which is exactly the
// accident `pageIsALevel` exists to name (R8 §23.2). A P1 image has no mixer
// and therefore no family, and there the number is only ever a byte in transit.
const levelBase = (cfg) => (cfg.ram.lut ? lutPages(cfg).first : 0);

function protoRomFields(cfg, p, countLo = STATE.countLo) {
  const L = protocolLayout(cfg.ram.pub[0]);
  return { bootGeneration: p.bootGeneration ?? 0x1234,
    // Boot writes this into the control block and the engine echoes it into
    // every face. The width witness sets it to a constant that is not the boot
    // generation's own bytes, so three neighbouring bytes are three different
    // values and a duplicating read cannot come back looking right.
    phaseGeneration: p.phaseGeneration ?? 0,
    width: !!p.width, wideRead: !!p.wideRead,
    between: p.between ?? 8,
    skipLive: !!p.skipLive, skipBulk: !!p.skipBulk,
    snapshotBytes: SNAPSHOT_BYTES,
    select: L.publishSelect.offset,
    // The selector, then the one face it names — byte by byte, because the
    // 68000 has no wider access to Z80 RAM than that (R19 §46.3).
    faceBytes: SNAPSHOT_BYTES,
    face0: L.faces[0].observationNumber.offset,
    face1: L.faces[1].observationNumber.offset,
    stride: SNAPSHOT_STRIDE,
    bootGen: L.control.bootGeneration.offset,
    phaseGen: L.control.phaseGeneration.offset,
    commandCommit: L.control.commandCommit.offset,
    phaseCommit: L.control.phaseCommit.offset,
    // The mailbox: where its payload lives, one well-formed bundle, and the
    // byte the Z80 answers with.
    queue: !!p.queue, qfault: p.qfault ?? null, piece: p.piece ?? null,
    // A real host driving the mailbox: read the snapshot, aim `lead`
    // observations ahead, then read the ack and publish if the box is free.
    // There is no lead any more: the boundary is chosen from the decoder's own
    // live counter inside the publish attempt (R21 §50.2).
    live: !!p.live, refresh: p.refresh ?? 8,
    // THE LISTENING TOUR (§46.4): a section table instead of a rolling walk,
    // so the same image can be played to an ear on a fixed timeline.
    tour: p.tour ? tourBytes(levelBase(cfg)) : null,
    // WHICH PAGE IS LEVEL ZERO. The mixer's page number is an absolute Z80 page
    // and the level family does not start at 0 — in the 15-level profile it is
    // $0C00..$1B00, so page 12 is silence and page 26 is unity. A host staging
    // 0..14 is staging the code region as a volume table, which is exactly the
    // accident `pageIsALevel` exists to name (R8 §23.2).
    levelBase: levelBase(cfg),
    // ONE FM TRANSACTION FROM THE 68000 (§33.6 step 5, R24 §55.3 step 2).
    ym: p.ym ? { reg: 0x40, value: 0x7f, every: 64, mode: "grab", ...p.ym } : null,
    // ONE FRAME OF PSG A LOOP (R25 §57.3). The stream is the reference
    // driver's own, in its own order, or a small controlled one.
    psg: p.psg ? { split: 0, ...p.psg, bytes: psgStream(p.psg.stream) } : null,
    // WHICH DECODE STATE THIS BUILD HAS. The protocol's globals are laid out
    // FROM the decoder's own counter, and P1's state is six bytes where the
    // split 2ch one is thirteen — so a host that assumed P1's offset read a
    // byte that was not the ack at all, found the box busy for ever, and
    // published nothing while every other number in the run looked healthy.
    commandAck: protoGlobals(cfg.ram.glob[0] + GLOB.decode, countLo).commandAck,
    // THE DECODER'S OWN COUNTER, which the publication stage starts on: the
    // host reads its low byte inside the same grab as the ack and picks the
    // bundle whose boundary is that counter's next one (R21 §50.2).
    liveCount: protoGlobals(cfg.ram.glob[0] + GLOB.decode, countLo).stage,
    pfault: p.pfault ?? null,
    mailbox: mailboxLayout(cfg.ram.queue ? cfg.ram.queue[0] : 0x1d00).base,
    recordBytes: QREC_BYTES,
    record: QREC_RECORD };
}

/**
 * THE TRANSFER PERIOD, AS TWO BOUNDS AND A TARGET (R20 §48.5).
 *
 * The fixed `every: 6144` was one lap of DBRA and nothing else, so the 68000's
 * own execution time was added on top of it and the interval was always longer
 * than the lap it was named after. What the host actually has to satisfy is a
 * pair of bounds:
 *
 *   at least  one H observation interval, or two transfers land inside one and
 *             their bus stops ADD against the 1,500 master live contract
 *   at most   masterHz / 120, because an update is two transfers and R17 §43.6
 *             step 6 asks for 60 desired-state updates a second
 *
 * The stops are what each path measured inside the complete 2ch image (R20
 * §48.4); they are part of the interval, and the 68000 spends them in the grant
 * poll, so the wait cannot be sized without them. The emitter prices its own
 * instructions and solves for the two DBRA counts.
 */
export const MASTER_HZ = 53693175;
export const UPDATES_PER_SECOND = 60;             // R17 §43.6 step 6
// WHAT A DBRA ITERATION IS WORTH, MEASURED (R20 §48.5). Ten 68000 cycles would
// be seventy master, and with the display off that is exactly what the
// calibration reports. With the display ON the VDP takes bus cycles from the
// 68000 and the same loop runs slower — 3.8% slower, which over one lap of
// waiting is 16,500 master and is why the first generated period produced a
// 455,307 master interval where it had solved for 438,762.
//
// So it is measured rather than assumed: the "load calibration, display on"
// case reports it and FAILS if it has moved from this number, and
// dac-stream:decoder fails if the interval a period produces lands outside the
// window it was generated for. Both ends are checked, every run.
export const DBRA_MASTER = 72.653;
export const MASTER_PER_CYCLE = DBRA_MASTER / 10;
export function transferPeriod(cfg, p) {
  const lapMaster = cfg.cycleSlots * cfg.periodNum;
  return { lapMaster, ceilMaster: MASTER_HZ / (2 * UPDATES_PER_SECOND),
    density: p.density ?? 1, masterPerCycle: MASTER_PER_CYCLE,
    ...(p.targetMaster ? { targetMaster: p.targetMaster } : {}),
    // Measured STOP -> RESUME of each path in the complete 2ch+CSM image.
    stopRead: p.stopRead ?? 1150, stopPublish: p.stopPublish ?? 1250 };
}

export function resolveCase(c0, { compensation = null, captureOffset = null, fault = null } = {}) {
  if (fault && !FAULTS[fault]) throw new Error(`unknown fault ${fault}; one of ${Object.keys(FAULTS)}`);
  const cfg = buildConfig(c0.cfg);
  const coop = c0.cooperative
    ? { ...c0.cooperative, ...(compensation === null ? {} : { compensation }) } : null;
  let grab = c0.grab ? { ...c0.grab }
    : c0.bankOnly ? { cooperative: true, disabled: true }
    : c0.calibrate ? { calibrate: true, disabled: true, vdp: !!c0.vdp }
    // An observer case has a display and a busy 68000. It has no transfer
    // protocol of its own; `stall` injects a plain, UNREPAID bus grab, which is
    // the disturbance the observer is supposed to notice.
    // A SPLIT case is an observer case whose observer is distributed through
    // the complete 2ch engine. Same disturbances, same idle-or-loaded 68000;
    // what differs is that there is nothing to publish (R8 §23.5 step 3).
    // A SPLIT CASE THAT ALSO CARRIES THE REAL HANDSHAKE (R19 §46.3). The
    // complete 2ch engine and the 68000's mailbox transfer in one image: until
    // now the first was verified in JS slots and the second on a P1 output
    // image, and nothing ran both at once.
    : c0.split?.proto ? { vdp: true, load: c0.split.load,
        bootNops: c0.split.bootNops, startNops: c0.split.startNops,
        every: c0.split.proto.every,
        ...(c0.split.proto.live ? { period: transferPeriod(cfg, c0.split.proto) } : {}),
        ...(c0.cfg?.csmHost ? { csmVoice: CSM_TEST_VOICE,
          csmFreq: { ...CSM_TEST_FREQ, hiAt: cfg.ram.glob[0] + GLOB.csmHi,
            loAt: cfg.ram.glob[0] + GLOB.csmLo } } : {}),
        proto: protoRomFields(cfg, { ...c0.split.proto,
          ...(fault in QUEUE_FAULTS ? { qfault: fault.slice(2) } : {}) },
        SPLIT_STATE.countLo) }
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
        ...(c0.observer.proto.live ? { period: transferPeriod(cfg, c0.observer.proto) } : {}),
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
    if (fault && !(fault in PUBLISH_FAULTS) && !(fault in QUEUE_FAULTS)
      && !(fault in ORDER_FAULTS)) grab.fault = fault;
    // The withdrawn word-move read is a property of the HOST'S protocol code,
    // not of the transfer's payload, so it reaches the proto fields rather than
    // `grab.fault` (R20 §48.3).
    // The adaptive choice is the HOST'S protocol code too, so these reach the
    // proto fields rather than `grab.fault` (R21 §50.4).
    if (fault in PICK_FAULTS) {
      if (!grab.proto?.live)
        throw new Error(`fault ${fault} only applies to a live mailbox host`);
      grab.proto.pfault = fault;
    }
    if (fault === "wide-read") {
      if (!grab.proto?.width)
        throw new Error("fault wide-read only applies to the access-width case");
      grab.proto.wideRead = true;
    }
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
    const r = generateSplit(cfg, { stackFill: true, ...c0.split.place,
      ...(fault in ORDER_FAULTS ? { counterLate: true } : {}) });
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
  const { rom, sha, access } = buildRom(image, samples, c.grab ?? null);
  const rpath = join(outDir, `probe-${cfg.stamp}-${caseId}-${sha}.bin`);
  writeFileSync(rpath, rom);
  return { cfg, gen, grab: resolved.grab, resolved: c, caseId, image, samples, sha,
    rpath, zpath, access };
}
