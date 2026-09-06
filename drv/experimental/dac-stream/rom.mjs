// A minimal Mega Drive cartridge that runs the dac-stream image, and nothing
// else (docs/dac-engine-implementation.md §10.3 step 3, R1: "BlastEm用の最小
// ROMで、出力専用 → 現在の2ch → 制御されたBUSREQ/時刻読出し → ROM/VDP負荷の
// 順に確認する").
//
// THERE IS NO 68000 TOOLCHAIN HERE, so the bootstrap is emitted directly. That
// is not a stunt: the whole 68000 side of this test is "hold the Z80, copy 7 KB,
// set the bank, let go", about twenty instructions, and encoding them by hand
// is smaller than depending on a cross-compiler the environment does not have.
// Every encoding carries its bit layout in a comment, because a wrong opcode
// here looks exactly like a driver bug.
//
// What it deliberately does NOT do: no VDP bring-up, no display, no interrupt
// handlers, no TMSS dance. Nothing in this engine needs a VDP, and R1 puts the
// VDP's bus load in a later stage — so the first measurement is the Z80 alone
// on the bus, which is the cleanest thing the machine can be asked.
import { createHash } from "node:crypto";

const ROM_SIZE = 0x80000;         // 512 KB, padded
const CODE = 0x000200;            // the bootstrap
const Z80IMG = 0x001000;          // the Z80 image, verbatim
const SAMPLES = 0x010000;         // sample pages — bank 2 (0x10000 >> 15)
const Z80_BASE = 0xa00000;
const Z80_BUSREQ = 0xa11100;
const Z80_RESET = 0xa11200;
const Z80_BANK = 0xa06000;

/** A two-pass emitter: labels are patched after the layout is known. */
class M68k {
  constructor(org) { this.org = org; this.b = []; this.fix = []; this.lab = new Map(); }
  get pc() { return this.org + this.b.length; }
  w(v) { this.b.push((v >> 8) & 0xff, v & 0xff); }
  l(v) { this.w((v >>> 16) & 0xffff); this.w(v & 0xffff); }
  label(n) { this.lab.set(n, this.pc); }
  // ── the twenty instructions this needs, with their encodings ────────────
  // MOVE: 00 SS ddd mmm MMM rrr — SS 01 byte, 11 word, 10 long
  moveWimm(imm, addr) { this.w(0x33fc); this.w(imm); this.l(addr); }   // move.w #i,(abs).l
  moveBimm(imm, addr) { this.w(0x13fc); this.w(imm & 0xff); this.l(addr); } // move.b #i,(abs).l
  moveWabsD(addr, d) { this.w(0x3039 | (d << 9)); this.l(addr); }      // move.w (abs).l,Dn
  moveWimmD(imm, d) { this.w(0x303c | (d << 9)); this.w(imm); }        // move.w #i,Dn
  moveBpost() { this.w(0x12d8); }                                       // move.b (a0)+,(a1)+
  leaAbs(addr, a) { this.w(0x41f9 | (a << 9)); this.l(addr); }          // lea (abs).l,An
  andiW(imm, d) { this.w(0x0240 | d); this.w(imm); }                    // andi.w #i,Dn
  moveSR(imm) { this.w(0x46fc); this.w(imm); }                          // move.w #i,SR
  nop() { this.w(0x4e71); }
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

/**
 * @param image     the assembled Z80 image (uploaded verbatim to $A00000)
 * @param samples   bytes placed at the sample bank; the Z80 sees them at $8000
 * @param grab      {every, cycles} — the 68000 takes the Z80 bus periodically
 */
export function buildRom(image, samples = null, grab = null) {
  const rom = new Uint8Array(ROM_SIZE);
  rom.fill(0xff, 0x200);

  const m = new M68k(CODE);
  m.moveSR(0x2700);                       // interrupts off; nothing here uses one
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
  const bank = SAMPLES >>> 15;
  for (let i = 0; i < 9; i++) m.moveBimm((bank >> i) & 1, Z80_BANK);
  m.moveWimm(0x0000, Z80_RESET);          // pulse reset
  for (let i = 0; i < 8; i++) m.nop();    // …held for a few microseconds
  m.moveWimm(0x0100, Z80_RESET);
  m.moveWimm(0x0000, Z80_BUSREQ);         // let go: the Z80 starts at $0000
  m.label("idle");
  if (grab) {
    // R1 step 3 stage 3: the 68000 takes the bus on a schedule, holds it, and
    // releases it. This is the ONLY thing on this cartridge that can stop the
    // Z80, so whatever the DAC log shows around it is attributable.
    m.moveWimmD(grab.every, 1);
    m.label("wait1");
    m.dbra(1, "wait1");                   // ~10 cycles an iteration
    m.moveWimm(0x0100, Z80_BUSREQ);
    m.moveWimmD(grab.cycles, 1);
    m.label("hold");
    m.dbra(1, "hold");
    m.moveWimm(0x0000, Z80_BUSREQ);
  }
  m.bra("idle");
  const code = m.done();
  rom.set(code, CODE);

  // Vectors: SP, PC, and every exception into a halt so a fault is a silence
  // rather than a wild run.
  const dv = new DataView(rom.buffer);
  dv.setUint32(0, 0x00fffff0);
  dv.setUint32(4, CODE);
  const trap = CODE + code.length - 4;    // the `bra idle` at the end
  for (let v = 2; v < 64; v++) dv.setUint32(v * 4, trap);

  // A plausible header. BlastEm does not check it; a human reading a hex dump
  // does.
  const put = (at, str, len) => {
    const s = str.padEnd(len, " ");
    for (let i = 0; i < len; i++) rom[at + i] = s.charCodeAt(i) & 0x7f;
  };
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
