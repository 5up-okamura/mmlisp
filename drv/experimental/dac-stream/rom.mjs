// A minimal Mega Drive cartridge that runs the dac-stream image, and nothing
// else (docs/dac-engine-implementation.md §10.3 step 3, R1: "BlastEm用の最小
// ROMで、出力専用 → 現在の2ch → 制御されたBUSREQ/時刻読出し → ROM/VDP負荷の
// 順に確認する").
//
// The bootstrap and transfer probes use a small direct 68000 emitter.
// Every encoding carries its bit layout in a comment, because a wrong opcode
// here looks exactly like a driver bug.
//
// What it deliberately does NOT do: no VDP bring-up, no display, no interrupt
// handlers, no TMSS dance. Nothing in this engine needs a VDP, and R1 puts the
// VDP's bus load in a later stage — so the first measurement is the Z80 alone
// on the bus, which is the cleanest thing the machine can be asked.
import { COOP } from "./cooperative.mjs";
import { createHash } from "node:crypto";

const ROM_SIZE = 0x80000;         // 512 KB, padded
const CODE = 0x000200;            // the bootstrap
const Z80IMG = 0x001000;          // the Z80 image, verbatim
const SAMPLES = 0x010000;         // sample pages — bank 2 (0x10000 >> 15)
const Z80_BASE = 0xa00000;
const Z80_BUSREQ = 0xa11100;
const Z80_RESET = 0xa11200;
const Z80_BANK = 0xa06000;
// A write here is logged by the probe with its 68000 timestamp and nothing
// else happens (§12.2 A/D: the interrupt-to-entry delay and the landing of
// each request have to be observable from the 68000's side, not inferred from
// the Z80's). It is a real bus write costing real cycles, so a ROM built with
// marks is a DIFFERENT ROM and is reported as one.
const MARK = 0xa130f1, MARKW = 0xa130f2;
export const MARKS = { entry: 1, request: 2, released: 3, skipped: 4, missed: 5,
  loadTick: 6, calBegin: 0x10, calEnd: 0x11,
  // An exception. Every unused vector goes here, the mark makes it visible to
  // the gate, and the halt stops the machine from stacking frames until it
  // walks off the end of RAM. The previous vector target was the trailing
  // `bra idle`, which sent a divide-by-zero straight back into the loop that
  // caused it — a 2-second run passed and a 10-second one died writing to
  // $DFFFFE.
  fault: 0x7f };

/** A two-pass emitter: labels are patched after the layout is known. */
class M68k {
  constructor(org) { this.org = org; this.b = []; this.fix = []; this.lab = new Map(); }
  get pc() { return this.org + this.b.length; }
  w(v) { this.b.push((v >> 8) & 0xff, v & 0xff); }
  l(v) { this.w((v >>> 16) & 0xffff); this.w(v & 0xffff); }
  label(n) { this.lab.set(n, this.pc); }
  // ── the instructions this needs, with their encodings ────────────
  // MOVE: 00 SS ddd mmm MMM rrr — SS 01 byte, 11 word, 10 long
  moveWimm(imm, addr) { this.w(0x33fc); this.w(imm); this.l(addr); }   // move.w #i,(abs).l
  moveBimm(imm, addr) { this.w(0x13fc); this.w(imm & 0xff); this.l(addr); } // move.b #i,(abs).l
  moveWabsD(addr, d) { this.w(0x3039 | (d << 9)); this.l(addr); }      // move.w (abs).l,Dn
  moveWimmD(imm, d) { this.w(0x303c | (d << 9)); this.w(imm); }        // move.w #i,Dn
  moveWDtoA(d, a) { this.w(0x3080 | (a << 9) | d); } // move.w Dn,(An)
  btstZeroA(a) { this.w(0x0810 | a); this.w(0); }     // btst #0,(An), byte
  tstBA(a) { this.w(0x4a10 | a); }                    // tst.b (An)
  moveBimmA(imm,a) { this.w(0x10bc | (a << 9)); this.w(imm & 255); }
  moveBDtoA(d, a) { this.w(0x1080 | (a << 9) | d); }                    // move.b Dn,(An)
  moveBpost() { this.w(0x12d8); }                                       // move.b (a0)+,(a1)+
  moveBabsD(addr, d) { this.w(0x1039 | (d << 9)); this.l(addr); }       // move.b (abs).l,Dn
  cmpBDD(s, d) { this.w(0xb000 | (d << 9) | s); }                       // cmp.b Ds,Dd
  moveBpostA(sa, da) { this.w(0x10d8 | (da << 9) | sa); }               // move.b (As)+,(Ad)+
  moveWpost() { this.w(0x32d8); }                                       // move.w (a0)+,(a1)+
  moveLpost() { this.w(0x22d8); }                                       // move.l (a0)+,(a1)+
  moveLimm(imm, addr) { this.w(0x23fc); this.l(imm); this.l(addr); }   // move.l #i,(abs).l
  moveLimmD(imm, d) { this.w(0x203c | (d << 9)); this.l(imm); }        // move.l #i,Dn
  moveq(imm, d) { this.w(0x7000 | (d << 9) | (imm & 0xff)); }          // moveq #i,Dn
  divuD(s, d) { this.w(0x80c0 | (d << 9) | s); }                       // divu.w Ds,Dd
  rte() { this.w(0x4e73); }
  // 32-bit register arithmetic and the few ops computed timing needs. Every
  // encoding: op-word bit layout in the comment.
  subLimmD(imm, d) { this.w(0x0480 | d); this.l(imm); }               // subi.l #i,Dn
  addLimmD(imm, d) { this.w(0x0680 | d); this.l(imm); }               // addi.l #i,Dn
  cmpLimmD(imm, d) { this.w(0x0c80 | d); this.l(imm); }               // cmpi.l #i,Dn
  tstL(d) { this.w(0x4a80 | d); }                                      // tst.l Dn
  bpl(name) { this.w(0x6a00); this.fix.push([this.pc, name]); this.w(0); }
  bcs(name) { this.w(0x6500); this.fix.push([this.pc, name]); this.w(0); }   // unsigned lower
  moveLD(s, d) { this.w(0x2000 | (d << 9) | s); }                      // move.l Ds,Dd
  muluImm(imm, d) { this.w(0xc0fc | (d << 9)); this.w(imm); }          // mulu.w #i,Dn
  divuImm(imm, d) { this.w(0x80fc | (d << 9)); this.w(imm); }          // divu.w #i,Dn
  addqL(n, d) { this.w(0x5080 | ((n & 7) << 9) | d); }                 // addq.l #n,Dn
  tstBabs(addr) { this.w(0x4a39); this.l(addr); }                      // tst.b (abs).l
  clrBabs(addr) { this.w(0x4239); this.l(addr); }                      // clr.b (abs).l
  moveLDabs(d, addr) { this.w(0x23c0 | d); this.l(addr); }             // move.l Dn,(abs).l
  moveLabsD(addr, d) { this.w(0x2039 | (d << 9)); this.l(addr); }      // move.l (abs).l,Dn
  leaAbs(addr, a) { this.w(0x41f9 | (a << 9)); this.l(addr); }          // lea (abs).l,An
  andiW(imm, d) { this.w(0x0240 | d); this.w(imm); }                    // andi.w #i,Dn
  moveSR(imm) { this.w(0x46fc); this.w(imm); }                          // move.w #i,SR
  nop() { this.w(0x4e71); }
  mark(n) { this.moveBimm(n, MARK); }                                   // 20 cycles
  markHV() { this.moveWabsD(0xc00008, 1); this.w(0x33c1); this.l(MARKW); } // 16 + 20
  // Branches and dbra take a 16-bit displacement from the extension word.
  dbra(d, name) { this.w(0x51c8 | d); this.fix.push([this.pc, name]); this.w(0); }
  bne(name) { this.w(0x6600); this.fix.push([this.pc, name]); this.w(0); }
  beq(name) { this.w(0x6700); this.fix.push([this.pc, name]); this.w(0); }
  bra(name) { this.w(0x6000); this.fix.push([this.pc, name]); this.w(0); }
  done() {
    for (const [at, name] of this.fix) {
      const target = this.lab.get(name);
      if (target === undefined) throw new Error(`unresolved label ${name}`);
      const disp = target - at;
      if (disp < -0x8000 || disp > 0x7fff) throw new Error(`branch to ${name} out of range`);
      const i = at - this.org;
      this.b[i] = (disp >> 8) & 0xff;
      this.b[i + 1] = disp & 0xff;
    }
    return Uint8Array.from(this.b);
  }
}

// THE FOREGROUND LOAD (§12.2 A). The point of a load is to make the interrupt
// arrive at an arbitrary point inside a LONG instruction, so that the entry
// delay varies the way it does in a real program. The first version divided
// $12345678 by 7, whose quotient does not fit in 16 bits: DIVU detects the
// overflow, leaves the operands alone and takes an early exit (M68000PRM 4-96;
// this core adds ten cycles and branches out before the division loop), so
// every iteration took the SHORT path and the load measured nothing. The
// dividend is now reloaded before each divide, both so the quotient fits and
// so one iteration's remainder cannot become the next one's operand.
//
// `calibrate` measures what these actually cost, in this core, with interrupts
// masked — a mark pair with an empty body gives the mark instruction's own
// cost, and everything else is that subtracted from a pair around N of them.
const LOAD_DIVIDEND = 0x00010000;         // / 7 = $2492, a quotient that fits
const OVERFLOW_DIVIDEND = 0x12345678;     // / 7 overflows: the early exit
export const LOADS = ["divu", "short", "masked", "none"];
export const PROTO_WORK = 0xff0100;   // where the host parks what it read
// One well-formed command record, in ROM, for the host to publish. It is a
// record and not eight arbitrary bytes because the consumer that will read it
// steps by `size`, and a test that never wrote a size would not have exercised
// that at all.
const QREC = 0x000f00;   // between the 68000 code and the Z80 image
const CAL = { markPair: 0x1a, nop: 0x10, divu: 0x12, overflow: 0x14,
  divuBig: 0x16, masked: 0x18, n: 32, nops: 256 };

// The payload copy, the commit, and the four ways it is deliberately broken.
// The gate has to FAIL on each of these; a check that cannot fail is not a
// check, and the HBlank cases were being scored on their PCM alone, which the
// transfer's content cannot reach (§12.2 B).
const FAULT_APPLIED = new Set();
function emitTransfer(m, { bytes, fault }, { marks = false } = {}) {
  if (fault && fault !== "late-request") FAULT_APPLIED.add(fault);
  const commit = () => m.moveBimmA(1, 4);            // move.b #1,(a4) — the local commit
  if (fault === "early-commit") commit();
  const n = fault === "drop-copy" ? bytes - 1 : bytes;
  for (let i = 0; i < n; i++) m.moveBpost();
  if (fault !== "no-commit" && fault !== "early-commit") commit();
  m.moveWDtoA(4, 2);                                 // release
  if (marks) m.mark(MARKS.released);
}

// Reg 1 = $44: display on, mode 5, and NO vertical interrupt — every unused
// vector is the halt trap, and a halt taken at level 6 would mask the level-4
// HBlank for the rest of the run. (It did.) Reg 10 is the HInt line counter,
// which only matters when a handler is installed.
// The VDP is brought up for the observer cases too: the counter a phase
// observer reads belongs to a VDP that is drawing, and one that is idle is not
// the machine the engine will live in.
function vdpSetup(m, hintLine = 0xff) {
  for (const [reg, val] of [[0, 0x14], [1, 0x44], [2, 0x30], [3, 0x3c], [4, 0x07],
    [5, 0x6c], [6, 0x00], [7, 0x00], [8, 0x00], [9, 0x00], [10, hintLine], [11, 0x00],
    [12, 0x81], [13, 0x3f], [14, 0x00], [15, 0x02], [16, 0x01], [17, 0x00], [18, 0x00]])
    m.moveWimm(0x8000 | (reg << 8) | val, 0xc00004);
}

// THE LOAD'S REGISTERS ARE NOT OPTIONAL. `emitLoad` reloads the dividend every
// iteration but the DIVISOR lives in d6 for the life of the run, and the
// observer's entry never set it: the load divided by whatever d6 held, which in
// this core is zero, so every iteration trapped instead of dividing. A build
// that reaches emitLoad("divu") without this having run is refused rather than
// producing a ROM that looks busy and is not.
let LOAD_READY = false;
function initLoad(m, kind, { fault = null } = {}) {
  if (kind === "divu") {
    if (fault === "zero-divisor") { m.moveq(0, 6); FAULT_APPLIED.add("zero-divisor"); }
    else m.moveq(7, 6);
  }
  LOAD_READY = true;
}

const loadKind = (load) => load === false || load === "none" ? "none"
  : load === true || load === undefined ? "divu" : load;

/** One iteration of the idle load. `n` disambiguates the labels it emits. */
function emitLoad(m, kind, n = 0) {
  if (!LOAD_READY) throw new Error(`emitLoad(${kind}) before initLoad — the divisor would be whatever d6 held`);
  if (kind === "none") return;
  if (kind === "short") { for (let i = 0; i < 4; i++) m.nop(); return; }
  if (kind === "divu") {
    for (let i = 0; i < 4; i++) { m.moveLimmD(LOAD_DIVIDEND, 5); m.divuD(6, 5); }
    return;
  }
  if (kind === "masked") {
    // A bounded stretch with level 4 masked: the HInt raised inside it is LOST,
    // which is the case §12.2 D asks to be reproduced rather than assumed away.
    // d1, not d4: d3 and d4 carry the BUSREQ assert/release words for the whole
    // run, and a load that borrowed d4 wrote 200 to $A11100 instead of 0 — the
    // Z80 was never released and the case measured an engine that never ran.
    // Anything the load touches must be either reloaded every iteration or one
    // of the registers the handler does not keep.
    // Long enough to outlast the tick interval under test: 600 iterations is
    // ~6,000 68000 cycles, ~12 scanlines, so ticks ARE lost and the handler's
    // recovery is exercised rather than assumed.
    m.moveSR(0x2700);
    m.moveWimmD(600, 1);
    m.label(`mask${n}`); m.dbra(1, `mask${n}`);
    m.moveSR(0x2300);
    return;
  }
  throw new Error(`unknown load ${kind}; one of ${LOADS}`);
}

/**
 * @param image     the assembled Z80 image (uploaded verbatim to $A00000)
 * @param samples   bytes placed at the sample bank; the Z80 sees them at $8000
 * @param grab      {every, bytes} — the 68000 copies into Z80 RAM periodically
 */
export function buildRom(image, samples = null, grab = null) {
  if (image.length > 0x2000) throw new Error("Z80 upload exceeds RAM");
  // A protocol case carries no `bytes`: what it moves is the layout, not a
  // block copy, and its sizes come from protocol.mjs.
  if (grab && !grab.disabled && !grab.proto
    && (!Number.isInteger(grab.bytes) || grab.bytes < 1 || grab.bytes > 256))
    throw new Error("transfer size must be 1..256 bytes");
  if (grab?.every !== undefined && (!Number.isInteger(grab.every) || grab.every < 0 || grab.every > 65535))
    throw new Error("DBRA delay must be 0..65535");
  const load = loadKind(grab?.load);
  // WHERE A TRANSFER LANDS: the command queue's page in the 2ch map, and the
  // same address in P1, where nothing else claims it.
  const target = grab?.target ?? 0x1d00;
  const marks = !!grab?.marks;
  FAULT_APPLIED.clear();
  LOAD_READY = false;
  const rom = new Uint8Array(ROM_SIZE);
  rom.fill(0xff, 0x200);

  const m = new M68k(CODE);
  m.moveSR(0x2700);                       // interrupts off; nothing here uses one
  // TMSS: models from the Mega Drive 2 on keep the VDP locked until 'SEGA' is
  // written to $A14000. Guarded by the version register's low nibble, as the
  // official boot code does, so a model without TMSS is left alone.
  m.w(0x1039); m.l(0xa10001);             // move.b ($A10001).l,d0
  m.w(0x0200); m.w(0x000f);               // andi.b #$0F,d0
  m.beq("notmss");
  m.moveLimm(0x53454741, 0xa14000);       // move.l #'SEGA',($A14000).l
  m.label("notmss");
  m.moveWimm(0x0100, Z80_BUSREQ);         // take the Z80 bus
  m.moveWimm(0x0100, Z80_RESET);          // and lift its reset
  m.label("wait");
  m.moveWabsD(Z80_BUSREQ, 0);
  m.andiW(0x0100, 0);                     // bit 8 set = the bus is NOT ours yet
  m.bne("wait");
  m.leaAbs(Z80IMG, 0);
  m.leaAbs(Z80_BASE, 1);
  m.moveWimmD(image.length - 1, 0);
  m.label("copy");
  m.moveBpost();
  m.dbra(0, "copy");
  // The bank register is NINE serial writes, one bit each, LSB (A15) first.
  // It is written from here rather than from the Z80 because the Z80 has not
  // started yet — and because ~120 cycles of it does not belong in a sample
  // period (see the README's open ROM-window question).
  // A publishing observer writes its own state into 68k work RAM through the
  // window, so the bank points there rather than at the sample pages.
  const bank = ((grab?.cooperative || grab?.hint || grab?.publish) ? COOP.notify : SAMPLES) >>> 15;
  for (let i = 0; i < 9; i++) m.moveBimm((bank >> i) & 1, Z80_BANK);
  m.moveWimm(0x0000, Z80_RESET);          // pulse reset
  for (let i = 0; i < 8; i++) m.nop();    // …held for a few microseconds
  m.moveWimm(0x0100, Z80_RESET);
  if (grab?.cooperative || grab?.hint) {
    m.moveBimm(0, COOP.notify);
    m.moveBimm(0, Z80_BASE + COOP.commit);
  }
  // THE BOOT ORIGIN (R12 §33.2). The control block is written while the bus is
  // still held and the Z80 has not started, so the very first thing the engine
  // does is take its identity from it: which run this is, which phase stretch it
  // starts in, an empty queue, and the commit it has already seen. The host
  // sends no timed command until it reads a snapshot carrying this same boot
  // generation back.
  if (grab?.proto) {
    const P = grab.proto;
    // Little endian, like every multi-byte field in the layout.
    m.moveBimm(P.bootGeneration & 0xff, Z80_BASE + P.bootGen);
    m.moveBimm((P.bootGeneration >> 8) & 0xff, Z80_BASE + P.bootGen + 1);
    m.moveBimm(0, Z80_BASE + P.phaseGen);
    m.moveBimm(0, Z80_BASE + P.commandCommit);
    m.moveBimm(0, Z80_BASE + P.phaseCommit);   // …the phase commit LAST
    m.moveq(0, 2);                             // the phase generation, counted here
    m.moveq(0, 3);                             // …and the phase commit
    m.moveWimmD(P.between, 5);                 // live reads between invalidations
    if (P.queue || P.piece) m.moveq(0, 4);     // the mailbox's commit, counted here
  }
  // The Z80 begins when the bus is released, so nops placed BEFORE the release
  // move the engine's phase against the VDP's counters — which is how the
  // observer is asked the same question from every starting phase. `startNops`
  // moves the 68000 instead, and the two are not the same knob.
  for (let i = 0; i < (grab?.bootNops ?? 0); i++) m.nop();
  m.moveWimm(0x0000, Z80_BUSREQ);         // let go: the Z80 starts at $0000
  for (let i=0; i<(grab?.startNops ?? 0); i++) m.nop();
  // ── instruction-time calibration (§12.2 A) ──────────────────────────────
  // Interrupts are still masked here and the 68000 never touches the Z80, so
  // the engine's own gate runs unchanged alongside: this case measures the
  // load, and proves that measuring it costs the DAC nothing.
  if (grab?.calibrate) {
    const pair = (id, body) => { m.mark(id); body(); m.mark(id + 1); };
    m.moveq(7, 6);
    m.moveWimmD(0x7fff, 7);
    pair(CAL.markPair, () => {});                       // the mark's own cost
    pair(CAL.nop, () => { for (let i = 0; i < CAL.nops; i++) m.nop(); });
    pair(CAL.divu, () => { for (let i = 0; i < CAL.n; i++) {
      m.moveLimmD(LOAD_DIVIDEND, 5); m.divuD(6, 5); } });
    pair(CAL.overflow, () => { for (let i = 0; i < CAL.n; i++) {
      m.moveLimmD(OVERFLOW_DIVIDEND, 5); m.divuD(6, 5); } });
    pair(CAL.divuBig, () => { for (let i = 0; i < CAL.n; i++) {
      m.moveLimmD(LOAD_DIVIDEND, 5); m.divuD(7, 5); } });
  }
  if (grab?.vdp && !grab.disabled) vdpSetup(m);
  if (grab?.optimized) {
    m.leaAbs(Z80_BUSREQ, 2);
    m.moveWimmD(0x0100, 3);
    m.moveWimmD(0x0000, 4);
    if (grab.cooperative) {
      m.leaAbs(COOP.notify, 3);
      m.leaAbs(Z80_BASE + COOP.commit, 4);
    }
  }
  // HBLANK-DRIVEN GRAB: no notification, no polling. The 68000 takes the bus
  // from the horizontal-interrupt handler every `line` lines, which is the
  // only way a game's 68000 could reach a window at all — it cannot spend its
  // time polling for an edge. Whether it LANDS in the window is the question,
  // so the idle loop runs `divu` (the longest common instruction, ~140 cycles)
  // to give the interrupt the latency jitter a real program has.
  if (grab?.hint) {
    // COMPUTED TIMING (grab.computed): the 68000 never sees a notification in
    // the steady state. At boot it waits for the FIRST window opening — the
    // one notification it ever reads — counts loop iterations to the next
    // HBlank tick, and from then on keeps `rem` = master clocks from the
    // current tick to the next window opening: each tick subtracts one line
    // (39 across the vblank reload, where no ticks come), a window already
    // behind is SKIPPED and counted, and a window due before the next tick is
    // reached by a busy-wait of `rem` in 68000 cycles less the handler's own
    // fixed path. The constants are the line (3,420), the window period
    // (26,880 = 5 slots), the loop, and a measured handler path — none is the
    // DAC's rate.
    // The window period is the Z80 schedule's, passed in by the resolved case
    // (§12.3) — neither CPU keeps a private copy of it any more.
    const LINE = 3420, WINDOW = grab.windowPeriod;
    if (!Number.isInteger(WINDOW)) throw new Error("hint transfer needs a resolved window period");
    const RAM = 0xff0100;
    // RAM+16 is the previous V counter; RAM+32/36 the diagnostic payload.
    const REM = RAM, TICKS = RAM + 4, FLAG = RAM + 8, MISSES = RAM + 12,
      SKIPS = RAM + 20, PATH = grab.path ?? 0;
    vdpSetup(m, grab.line - 1);
    m.leaAbs(Z80_BUSREQ, 2);
    m.moveWimmD(0x0100, 3);
    m.moveWimmD(0x0000, 4);
    m.leaAbs(Z80_BASE + COOP.commit, 4);
    m.moveLimmD(LOAD_DIVIDEND, 5);
    initLoad(m, load, { fault: grab.fault });
    if (grab.computed) {
      m.clrBabs(FLAG); m.moveLimm(0, TICKS); m.moveLimm(0, MISSES); m.moveLimm(0, SKIPS);
      m.moveLimm(WINDOW, REM); m.moveLimm(0, TICKS + 16);   // sane before the first tick
      // Capture: wait for the first opening (masked polling, ONCE), then count
      // 40-cycle iterations until the first tick marks FLAG.
      m.leaAbs(COOP.notify, 3);
      m.label("cap0"); m.tstBA(3); m.bne("cap0");
      m.label("cap1"); m.tstBA(3); m.beq("cap1");
      // prevV must be the line we are on NOW, or the first tick subtracts the
      // whole line number and wraps `rem` into an arbitrary boot constant.
      m.moveWabsD(0xc00008, 1); m.w(0xe049); m.moveLDabs(1, TICKS + 16);
      m.moveSR(0x2300);                   // ticks may come now
      m.moveq(0, 7);
      m.label("cap2"); m.addqL(1, 7); m.tstBabs(FLAG); m.beq("cap2");
      // addq.l 8 + tst.b (abs).l 16 + beq 10 = 34 68000 cycles = 238 master an iteration.
      m.muluImm(238, 7);
      m.moveLimmD(WINDOW, 6); m.w(0x9c87); // sub.l d7,d6
      // The capture's own fixed cost — the polling loop's exit, the loop above,
      // the first handler entry — as ONE constant in master clocks, measured
      // from where the grabs landed (a tight cluster 1,331 Z80 cycles after
      // the opening, spread 11). It is a property of this boot code.
      // Positive = grab earlier, negative = later; the landing is modulo the
      // window period, so the SHORT way round is the one to take.
      if (grab.captureOffset > 0) m.subLimmD(grab.captureOffset, 6);
      if (grab.captureOffset < 0) m.addLimmD(-grab.captureOffset, 6);
      m.moveLDabs(6, REM);
      m.clrBabs(FLAG);
      m.moveLimmD(LOAD_DIVIDEND, 5); initLoad(m, load, { fault: grab.fault });
      m.label("idle");
      emitLoad(m, load, 1);
      m.bra("idle");
      // ── the tick handler ────────────────────────────────────────────────
      m.label("hint");
      // HOW WELL CAN THE 68000 SEE ITS OWN PHASE? The interrupt entry delay is
      // 65..215 cycles under a real load, which is wider than the window it is
      // aiming at — unless the handler can read a clock. The VDP's HV counter
      // is the only one it can read without taking the Z80 bus, and this
      // stamps it at entry so the mapping from what it READ to when it read it
      // can be measured. Diagnostic: two bus writes the real handler would not
      // make. d1 is scratch here and is reloaded below.
      if (grab.hv) m.markHV();
      if (marks) m.mark(MARKS.entry);      // FIRST, so entry-to-mark is one write
      m.w(0x13fc); m.w(1); m.l(FLAG);      // move.b #1,(FLAG)
      m.moveLabsD(TICKS, 0); m.addqL(1, 0); m.moveLDabs(0, TICKS);
      m.moveLabsD(REM, 0);
      // ELAPSED TIME COMES FROM THE V COUNTER, NOT FROM COUNTING TICKS. A tick
      // that arrives while this handler is busy-waiting is lost (level 4 is
      // masked), and counting ticks then leaves `rem` a whole line too large —
      // a one-line drift per window, which scatters the grabs uniformly. The
      // V counter is the VDP's own line number: HInts fire only on lines
      // 0..223, so V is unambiguous there, and the wrap from 223 back to 0 is
      // the 39-line vblank gap with no special case at all.
      m.moveWabsD(0xc00008, 1); m.w(0xe049);          // move.w ($C00008).l,d1 ; lsr.w #8,d1 → V
      m.moveLabsD(TICKS + 16, 2);                     // previous V
      m.moveLDabs(1, TICKS + 16);
      m.w(0x9242);                                    // sub.w d2,d1  → lines elapsed
      // On the wrap the elapsed lines are the frame length less the last
      // active line's number; `wrapLines` is that frame length as the HInt
      // sees it (262 by the line count; the emulator measured 261 — see below).
      m.bpl("dpos"); m.w(0x0641); m.w(grab.wrapLines ?? 262); m.label("dpos");
      m.muluImm(LINE, 1);                             // master clocks elapsed
      m.w(0x9081);                                    // sub.l d1,d0
      m.label("catch");                    // a window already behind us is a MISS
      m.tstL(0); m.bpl("ahead");
      m.addLimmD(WINDOW, 0);
      m.moveLabsD(MISSES, 1); m.addqL(1, 1); m.moveLDabs(1, MISSES);
      m.bra("catch");
      m.label("ahead");
      m.cmpLimmD(LINE, 0);
      m.bcs("due");
      m.moveLDabs(0, REM);
      m.rte();
      m.label("due");
      m.moveLD(0, 1);                      // d0 keeps rem for the update below
      m.subLimmD(PATH, 1);
      // THE DEADLINE IS A CONTRACT, NOT A CLAMP (§12.2 D). A remainder shorter
      // than the handler's own path cannot be reached: the old code rounded the
      // wait to zero and requested anyway, which is a request aimed at a window
      // that has already gone. It skips, counts, and waits for the next one.
      m.bpl("waitok");
      m.moveLabsD(SKIPS, 2); m.addqL(1, 2); m.moveLDabs(2, SKIPS);
      if (marks) m.mark(MARKS.skipped);
      m.addLimmD(WINDOW, 0); m.moveLDabs(0, REM); m.rte();
      m.label("waitok");
      m.divuImm(70, 1);                    // a 10-cycle dbra iteration is 70 master clocks
      m.w(0x0241); m.w(0xffff);            // andi.w #$ffff,d1
      if (grab.debugPayload) m.moveLDabs(1, RAM + 36);   // (diagnostic payload: the wait iterations)
      m.label("wait"); m.dbra(1, "wait");
      // Late on purpose: one window period of extra wait puts the request past
      // the window it was computed for, so the gate has something to catch.
      if (grab.fault === "late-request") {
        FAULT_APPLIED.add("late-request");
        m.moveWimmD(Math.round(WINDOW / 140), 1);   // half a period: between windows
        m.label("latewait"); m.dbra(1, "latewait");
      }
      // Diagnostic: carry the handler's own state as the payload, so every
      // grab logs what it BELIEVED next to where it LANDED.
      if (grab.debugPayload) { m.moveLDabs(0, RAM + 32); m.leaAbs(RAM + 32, 0); }
      else m.leaAbs(SAMPLES, 0);
      m.leaAbs(Z80_BASE + target, 1);
      if (marks) m.mark(MARKS.request);
      m.moveWDtoA(3, 2);                   // request
      m.label("hgrant2"); m.btstZeroA(2); m.bne("hgrant2");
      emitTransfer(m, grab, { marks });
      // The next window is one period past THIS one: d0 still holds the
      // remainder to the window just served, post-tick.
      m.addLimmD(WINDOW, 0);
      m.moveLDabs(0, REM);
      m.rte();
    } else {
      m.moveSR(0x2300);                   // level 4 (HBlank) may interrupt now
      m.label("idle");
      emitLoad(m, load, 2);
      m.bra("idle");
      m.label("hint");
      if (grab.hv) m.markHV();             // see the computed handler's note
      if (marks) m.mark(MARKS.entry);
      m.leaAbs(SAMPLES, 0);
      m.leaAbs(Z80_BASE + target, 1);
      if (marks) m.mark(MARKS.request);
      m.moveWDtoA(3, 2);                  // request
      m.label("hgrant"); m.btstZeroA(2); m.bne("hgrant");
      emitTransfer(m, grab, { marks });
      m.rte();
    }
  } else if (grab?.vdp && grab.disabled) {
    // The observer's host: a VDP that is drawing and a 68000 that is busy, and
    // nothing that touches the Z80 bus. Whatever the Z80 reads, it reads while
    // this is going on.
    vdpSetup(m);
    m.moveLimmD(LOAD_DIVIDEND, 5);
    // `skipInitForTest` exists so the guard below can be shown to fire; nothing
    // else sets it.
    if (!grab.skipInitForTest) initLoad(m, load, { fault: grab.fault });
    // `loadProbe` stamps the loop every 256 iterations, so that the observer's
    // OWN rom can be shown to have run the load it was meant to — the
    // calibration rom's instruction times are not a substitute for that. It is
    // a diagnostic build, and a different rom from the one under test.
    if (grab.loadProbe) m.moveWimmD(256, 0);
    m.label("idle");
    emitLoad(m, load, 3);
    if (grab.loadProbe) {
      m.w(0x5340);                         // subq.w #1,d0
      m.bne("idle");
      m.mark(MARKS.loadTick);
      m.moveWimmD(256, 0);
    }
    m.bra("idle");
  } else m.label("idle");
  if (grab?.hint) { /* handled above */ } else if (grab?.optimized) {
    // All setup precedes BUSREQ; short fixed packets have no DBRA inside it.
    if (!grab.cooperative || grab.every) {
      m.moveWimmD(grab.every, 1);
      m.label("wait1");
      m.dbra(1, "wait1");
    }
    m.leaAbs(SAMPLES, 0);
    m.leaAbs(Z80_BASE + target, 1);
    if (grab.cooperative) {
      // Never grab merely because an old ready flag is high. Both loops run
      // in a bounded, IRQ-masked polling section; lateness before it skips a window.
      // A physical status read also synchronizes BlastEm's CPU scheduler.
      // RAM-only polling can miss a short pulse at its default 3420-master
      // inter-CPU quantum. This is ROM code, charged on both CPUs; the emulator
      // is not modified to deliver a notification sooner.
      m.label("low"); m.btstZeroA(2); m.tstBA(3); m.bne("low");
      m.label("high"); m.btstZeroA(2); m.tstBA(3); m.beq("high");
      // Late on purpose: 40 nops is 160 68000 cycles, about 75 Z80 cycles, so
      // the request arrives after the 64-cycle window it was waiting for has
      // closed. The clean case here passes, which is what makes this fault
      // worth injecting: it is the only one with a passing baseline to break.
      if (grab.fault === "late-request") {
        FAULT_APPLIED.add("late-request");
        for (let i = 0; i < 40; i++) m.nop();
      }
    }
    m.moveWDtoA(3, 2);
    m.label("grant");
    m.btstZeroA(2);
    m.bne("grant");
    if (grab.cooperative) emitTransfer(m, grab, { marks });
    else {
      for (let i = 0; i < (grab.fault === "drop-copy" ? grab.bytes - 1 : grab.bytes); i++) m.moveBpost();
      m.moveWDtoA(4, 2);
    }
  } else if (grab?.proto && !grab.disabled) {
    // ── THE HOST SIDE OF THE RUNTIME PROTOCOL (R12 §33.3) ────────────────
    // Two pieces, and they are deliberately different: a LIVE transfer that
    // reads the published snapshot and changes nothing, and a BULK one that
    // declares the phase it just disturbed to be over. The Z80 tells them apart
    // by one byte — the commit — and by nothing else.
    //
    // d2 is the phase generation, d3 the commit, both counted in their own low
    // byte so `$ff -> $00` happens the way §33.3 asks it to be exercised rather
    // than being avoided.
    const P = grab.proto;
    m.moveWimmD(grab.every, 1);
    m.label("wait1");
    m.dbra(1, "wait1");
    // LIVE: take the bus, read the selector and the face it names, let go. It
    // writes nothing, so the phase it interrupts is still the phase it was.
    // ── ONE PIECE PER GRAB (R13 §35.3 step 3) ────────────────────────────
    // The five things a host actually does are different lengths, and a run
    // that does several reports one range covering them all. `piece` makes each
    // one a run of its own, so the sweep below is five measurements and not one
    // interval with five causes.
    const grabOnce = (label, body) => {
      m.moveWimm(0x0100, Z80_BUSREQ);
      m.label(label);
      m.moveWabsD(Z80_BUSREQ, 0);
      m.andiW(0x0100, 0);
      m.bne(label);
      body();
      m.moveWimm(0x0000, Z80_BUSREQ);
    };
    if (P.piece) {
      const one = {
        // The payload alone, with the commit left where it was, so nothing the
        // consumer can see has changed yet.
        payload: () => { m.leaAbs(QREC, 0); m.leaAbs(Z80_BASE + P.mailbox, 1);
          for (let i = 0; i < P.recordBytes; i++) m.moveBpost(); },
        // …and the piece that ends it: the commit alone, publishing everything
        // the payload wrote.
        commit: () => { m.addqL(1, 4); m.leaAbs(Z80_BASE + P.commandCommit, 1);
          m.moveBDtoA(4, 1); },
        // The answer: one byte the Z80 owns and the host only reads, which is
        // how the 68000 knows the box is free again.
        ack: () => { m.leaAbs(Z80_BASE + P.commandAck, 0); m.leaAbs(PROTO_WORK + 24, 1);
          m.moveBpost(); },
        // The time update: the selector, its pad and both faces, in one run.
        snapshot: () => { m.leaAbs(Z80_BASE + P.readRun, 0); m.leaAbs(PROTO_WORK, 1);
          for (let i = 0; i < P.readLongs; i++) m.moveLpost();
          for (let i = 0; i < P.readWords; i++) m.moveWpost(); },
        // And the invalidation: the generation, then its own commit, last.
        invalidate: () => { m.addqL(1, 2); m.addqL(1, 3);
          m.leaAbs(Z80_BASE + P.phaseGen, 1); m.moveBDtoA(2, 1);
          m.leaAbs(Z80_BASE + P.phaseCommit, 1); m.moveBDtoA(3, 1); },
        // THE WHOLE HANDSHAKE IN ONE GRAB (R17 §43.6 step 6): read the ack,
        // and if the box is free, put the next bundle in it and commit. Two
        // paths, deliberately — the STOP -> RESUME range this reports IS the
        // difference between "the box was busy" and "a bundle went out", and a
        // host scheduler has to fit the longer one.
        mailbox: () => {
          m.moveBabsD(Z80_BASE + P.commandAck, 0);
          m.cmpBDD(4, 0);                        // …against the commit we last wrote
          m.bne("mbbusy");
          m.leaAbs(QREC, 0);
          m.leaAbs(Z80_BASE + P.mailbox, 1);
          for (let i = 0; i < P.recordBytes; i++) m.moveBpost();
          m.addqL(1, 4);
          m.leaAbs(Z80_BASE + P.commandCommit, 1);
          m.moveBDtoA(4, 1);                     // …the commit, LAST
          m.label("mbbusy");
        },
      }[P.piece];
      if (!one) throw new Error(`unknown protocol piece ${P.piece}`);
      grabOnce("pgrant", one);
      m.bra("idle");
    } else {
    // EACH PIECE IS ITS OWN CASE as well as its own grab (R12 §33.4): the max
    // STOP -> RESUME of the live read and of the invalidation are different
    // numbers, and a run that does both reports one range covering the two.
    if (!P.skipLive) {
    m.moveWimm(0x0100, Z80_BUSREQ);
    m.label("grant");
    m.moveWabsD(Z80_BUSREQ, 0);
    m.andiW(0x0100, 0);
    m.bne("grant");
    // ONE STRAIGHT RUN: the selector, its pad and both faces, as long moves.
    // Which face is live is decided afterwards, in the host's own RAM, with the
    // bus already released — the reader's rule is unchanged, the reading is just
    // not what costs the Z80 anything.
    m.leaAbs(Z80_BASE + P.readRun, 0);
    m.leaAbs(PROTO_WORK, 1);
    for (let i = 0; i < P.readLongs; i++) m.moveLpost();
    for (let i = 0; i < P.readWords; i++) m.moveWpost();
    m.moveWimm(0x0000, Z80_BUSREQ);            // release
    }
    // ── A REAL COMMAND, PUBLISHED THE WAY §35.1 SEPARATES THEM ───────────
    // The payload goes in first and `commandCommit` LAST, and nothing else in
    // the control block is touched: an ordinary command must not cost the
    // engine its H synchronisation. There is no cursor to keep — one mailbox,
    // one commit byte, and the Z80's ack is what says the box is free.
    if (P.queue) {
      m.moveWimm(0x0100, Z80_BUSREQ);
      m.label("qgrant");
      m.moveWabsD(Z80_BUSREQ, 0);
      m.andiW(0x0100, 0);
      m.bne("qgrant");
      const n = P.qfault === "short-payload" ? P.recordBytes - 1 : P.recordBytes;
      const commit = () => { m.leaAbs(Z80_BASE + P.commandCommit, 1); m.moveBDtoA(4, 1); };
      // `commit-first` is the fault: the commit says the bundle is there before
      // any of it has been written.
      if (P.qfault === "commit-first") { m.addqL(1, 4); commit(); }
      m.leaAbs(QREC, 0);
      m.leaAbs(Z80_BASE + P.mailbox, 1);
      for (let i = 0; i < n; i++) m.moveBpost();
      if (P.qfault !== "commit-first") { m.addqL(1, 4); commit(); }
      m.moveWimm(0x0000, Z80_BUSREQ);
    }
    if (!P.skipBulk) m.dbra(5, "idle"); else m.bra("idle");
    // BULK / INVALIDATE: the fields first, the commit strictly LAST, and the
    // whole thing inside one grab so the Z80 cannot see it half done.
    if (!P.skipBulk) {
    m.moveWimmD(P.between, 5);
    m.addqL(1, 2);
    m.addqL(1, 3);
    m.moveWimm(0x0100, Z80_BUSREQ);
    m.label("grant2");
    m.moveWabsD(Z80_BUSREQ, 0);
    m.andiW(0x0100, 0);
    m.bne("grant2");
    m.leaAbs(Z80_BASE + P.phaseGen, 1);
    m.moveBDtoA(2, 1);                         // the new phase generation
    m.leaAbs(Z80_BASE + P.phaseCommit, 1);
    m.moveBDtoA(3, 1);                         // …and the commit, LAST
    m.moveWimm(0x0000, Z80_BUSREQ);
    }
    }
  } else if (grab && !grab.disabled && !grab.hint) {
    // R1 step 3 stage 3, and §3.6's decisive question: the 68000 takes the Z80
    // bus, copies `bytes` into Z80 RAM, and releases it. This is a REAL
    // transfer. Request-to-release and modeled stop-to-resume are distinct
    // measurements; BUSACK latency must not be counted as CPU stopped time.
    //
    // §3.6 (R1) gives the budget it has to fit: about 35.84 Z80 cycles inside
    // any one output interval, and about 60 Z80 cycles a frame in total.
    m.moveWimmD(grab.every, 1);
    m.label("wait1");
    m.dbra(1, "wait1");                   // ~10 68000 cycles an iteration
    m.moveWimm(0x0100, Z80_BUSREQ);       // request
    m.label("grant");
    m.moveWabsD(Z80_BUSREQ, 0);
    m.andiW(0x0100, 0);
    m.bne("grant");                       // …until it is ours
    m.leaAbs(SAMPLES, 0);                 // any ROM bytes will do
    // Into the command queue's page, which is exactly what a real transfer
    // would target and is the only region big enough that nothing reads.
    m.leaAbs(Z80_BASE + target, 1);
    m.moveWimmD(grab.bytes - 1, 2);
    m.label("xfer");
    m.moveBpost();
    m.dbra(2, "xfer");
    m.moveWimm(0x0000, Z80_BUSREQ);       // release
  }
  if (grab?.vdp && grab.disabled) { /* the idle loop closed itself above */ }
  else if (!grab?.hint) m.bra("idle");
  else { m.label("halt"); m.bra("halt"); }
  // The exception landing. Emitted last, reached only by a vector, and it
  // stops: a fault must not be able to look like a slow run.
  m.label("fault");
  m.mark(MARKS.fault);
  m.bra("fault");
  // A fault the emitted path never reached is a test that cannot fail, which is
  // exactly what it was written to prevent.
  if (grab?.fault === "short-load" || grab?.fault === "no-load-marks")
    FAULT_APPLIED.add(grab.fault);          // applied by the resolved case, not here
  if (grab?.fault && !FAULT_APPLIED.has(grab.fault))
    throw new Error(`fault ${grab.fault} does not apply to this transfer path`);
  const code = m.done();
  if (CODE + code.length > Z80IMG) throw new Error("68k code overlaps Z80 image");
  rom.set(code, CODE);

  // Vectors: SP, PC, and every exception into a halt so a fault is a silence
  // rather than a wild run.
  const dv = new DataView(rom.buffer);
  dv.setUint32(0, 0x00fffff0);
  dv.setUint32(4, CODE);
  const trap = m.lab.get("fault");
  for (let v = 2; v < 64; v++) dv.setUint32(v * 4, trap);
  if (grab?.hint) dv.setUint32(28 * 4, m.lab.get("hint"));   // level 4 = HBlank

  // A plausible header. BlastEm does not check it; a human reading a hex dump
  // does.
  const put = (at, str, len) => {
    const s = str.padEnd(len, " ");
    for (let i = 0; i < len; i++) rom[at + i] = s.charCodeAt(i) & 0x7f;
  };
  // The one command record the host publishes, at a fixed ROM address so the
  // 68000's `lea` is a constant and the instrument can compare what arrived.
  if (grab?.proto?.queue) rom.set(Uint8Array.from(grab.proto.record), QREC);
  put(0x100, "SEGA MEGA DRIVE ", 16);
  put(0x110, "(C)MMLISP 2026  ", 16);
  put(0x120, "MMLISP DAC-STREAM PROBE", 48);
  put(0x150, "MMLISP DAC-STREAM PROBE", 48);
  put(0x180, "GM 00000000-00", 14);
  put(0x190, "J               ", 16);
  dv.setUint32(0x1a0, 0x00000000);
  dv.setUint32(0x1a4, ROM_SIZE - 1);
  dv.setUint32(0x1a8, 0x00ff0000);
  dv.setUint32(0x1ac, 0x00ffffff);
  put(0x1f0, "JUE", 16);

  rom.set(image, Z80IMG);
  if (samples) rom.set(samples, SAMPLES);
  return { rom, sha: createHash("sha256").update(rom).digest("hex").slice(0, 16), codeBytes: code.length };
}
