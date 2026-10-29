// The 6502 as the Famicom's 2A03 runs it (no decimal mode), for File >
// Import > Song's NSF: the song's own code is run, and what it writes to the
// sound chips is the song (import-nsf.js). The official opcodes and the
// stable undocumented ones drivers are known to use (LAX, SAX, DCP, ISB,
// SLO, RLA, SRE, RRA, ANC, ALR, ARR, AXS, the NOPs, $EB's SBC); the unstable
// ones (XAA, AHX, TAS, SHX/SHY, LAS) and the JAMs stop the run. Cycles are
// the opcodes' base counts with a taken branch's and a page crossing's extra
// — what places a write within its frame, not a bus-exact count.
//
//   const cpu = new Cpu6502({ read(addr), write(addr, value) });
//   cpu.call(addr, { a, x, y, trap, limit }) → cycles, or -1 past the limit

const N = 0x80, V = 0x40, U = 0x20, B = 0x10, D = 0x08, I = 0x04, Z = 0x02, C = 0x01;

// Addressing modes.
const IMP = 0, IMM = 1, ZP = 2, ZPX = 3, ZPY = 4, ABS = 5, ABX = 6, ABY = 7, IZX = 8, IZY = 9, IND = 10, REL = 11, ACC = 12;

// [mnemonic, mode, cycles, +1 on a page crossed (reads)] by opcode.
const OPS = new Array(256);
const def = (list) => {
  for (const [name, entries] of Object.entries(list))
    for (const [op, mode, cyc, cross = 0] of entries) OPS[op] = [name, mode, cyc, cross];
};
def({
  ADC: [[0x69, IMM, 2], [0x65, ZP, 3], [0x75, ZPX, 4], [0x6d, ABS, 4], [0x7d, ABX, 4, 1], [0x79, ABY, 4, 1], [0x61, IZX, 6], [0x71, IZY, 5, 1]],
  AND: [[0x29, IMM, 2], [0x25, ZP, 3], [0x35, ZPX, 4], [0x2d, ABS, 4], [0x3d, ABX, 4, 1], [0x39, ABY, 4, 1], [0x21, IZX, 6], [0x31, IZY, 5, 1]],
  ASL: [[0x0a, ACC, 2], [0x06, ZP, 5], [0x16, ZPX, 6], [0x0e, ABS, 6], [0x1e, ABX, 7]],
  BCC: [[0x90, REL, 2]], BCS: [[0xb0, REL, 2]], BEQ: [[0xf0, REL, 2]], BMI: [[0x30, REL, 2]],
  BNE: [[0xd0, REL, 2]], BPL: [[0x10, REL, 2]], BVC: [[0x50, REL, 2]], BVS: [[0x70, REL, 2]],
  BIT: [[0x24, ZP, 3], [0x2c, ABS, 4]],
  BRK: [[0x00, IMP, 7]],
  CLC: [[0x18, IMP, 2]], CLD: [[0xd8, IMP, 2]], CLI: [[0x58, IMP, 2]], CLV: [[0xb8, IMP, 2]],
  CMP: [[0xc9, IMM, 2], [0xc5, ZP, 3], [0xd5, ZPX, 4], [0xcd, ABS, 4], [0xdd, ABX, 4, 1], [0xd9, ABY, 4, 1], [0xc1, IZX, 6], [0xd1, IZY, 5, 1]],
  CPX: [[0xe0, IMM, 2], [0xe4, ZP, 3], [0xec, ABS, 4]],
  CPY: [[0xc0, IMM, 2], [0xc4, ZP, 3], [0xcc, ABS, 4]],
  DEC: [[0xc6, ZP, 5], [0xd6, ZPX, 6], [0xce, ABS, 6], [0xde, ABX, 7]],
  DEX: [[0xca, IMP, 2]], DEY: [[0x88, IMP, 2]],
  EOR: [[0x49, IMM, 2], [0x45, ZP, 3], [0x55, ZPX, 4], [0x4d, ABS, 4], [0x5d, ABX, 4, 1], [0x59, ABY, 4, 1], [0x41, IZX, 6], [0x51, IZY, 5, 1]],
  INC: [[0xe6, ZP, 5], [0xf6, ZPX, 6], [0xee, ABS, 6], [0xfe, ABX, 7]],
  INX: [[0xe8, IMP, 2]], INY: [[0xc8, IMP, 2]],
  JMP: [[0x4c, ABS, 3], [0x6c, IND, 5]],
  JSR: [[0x20, ABS, 6]],
  LDA: [[0xa9, IMM, 2], [0xa5, ZP, 3], [0xb5, ZPX, 4], [0xad, ABS, 4], [0xbd, ABX, 4, 1], [0xb9, ABY, 4, 1], [0xa1, IZX, 6], [0xb1, IZY, 5, 1]],
  LDX: [[0xa2, IMM, 2], [0xa6, ZP, 3], [0xb6, ZPY, 4], [0xae, ABS, 4], [0xbe, ABY, 4, 1]],
  LDY: [[0xa0, IMM, 2], [0xa4, ZP, 3], [0xb4, ZPX, 4], [0xac, ABS, 4], [0xbc, ABX, 4, 1]],
  LSR: [[0x4a, ACC, 2], [0x46, ZP, 5], [0x56, ZPX, 6], [0x4e, ABS, 6], [0x5e, ABX, 7]],
  NOP: [[0xea, IMP, 2], [0x1a, IMP, 2], [0x3a, IMP, 2], [0x5a, IMP, 2], [0x7a, IMP, 2], [0xda, IMP, 2], [0xfa, IMP, 2],
    [0x80, IMM, 2], [0x82, IMM, 2], [0x89, IMM, 2], [0xc2, IMM, 2], [0xe2, IMM, 2],
    [0x04, ZP, 3], [0x44, ZP, 3], [0x64, ZP, 3], [0x14, ZPX, 4], [0x34, ZPX, 4], [0x54, ZPX, 4], [0x74, ZPX, 4], [0xd4, ZPX, 4], [0xf4, ZPX, 4],
    [0x0c, ABS, 4], [0x1c, ABX, 4, 1], [0x3c, ABX, 4, 1], [0x5c, ABX, 4, 1], [0x7c, ABX, 4, 1], [0xdc, ABX, 4, 1], [0xfc, ABX, 4, 1]],
  ORA: [[0x09, IMM, 2], [0x05, ZP, 3], [0x15, ZPX, 4], [0x0d, ABS, 4], [0x1d, ABX, 4, 1], [0x19, ABY, 4, 1], [0x01, IZX, 6], [0x11, IZY, 5, 1]],
  PHA: [[0x48, IMP, 3]], PHP: [[0x08, IMP, 3]], PLA: [[0x68, IMP, 4]], PLP: [[0x28, IMP, 4]],
  ROL: [[0x2a, ACC, 2], [0x26, ZP, 5], [0x36, ZPX, 6], [0x2e, ABS, 6], [0x3e, ABX, 7]],
  ROR: [[0x6a, ACC, 2], [0x66, ZP, 5], [0x76, ZPX, 6], [0x6e, ABS, 6], [0x7e, ABX, 7]],
  RTI: [[0x40, IMP, 6]], RTS: [[0x60, IMP, 6]],
  SBC: [[0xe9, IMM, 2], [0xeb, IMM, 2], [0xe5, ZP, 3], [0xf5, ZPX, 4], [0xed, ABS, 4], [0xfd, ABX, 4, 1], [0xf9, ABY, 4, 1], [0xe1, IZX, 6], [0xf1, IZY, 5, 1]],
  SEC: [[0x38, IMP, 2]], SED: [[0xf8, IMP, 2]], SEI: [[0x78, IMP, 2]],
  STA: [[0x85, ZP, 3], [0x95, ZPX, 4], [0x8d, ABS, 4], [0x9d, ABX, 5], [0x99, ABY, 5], [0x81, IZX, 6], [0x91, IZY, 6]],
  STX: [[0x86, ZP, 3], [0x96, ZPY, 4], [0x8e, ABS, 4]],
  STY: [[0x84, ZP, 3], [0x94, ZPX, 4], [0x8c, ABS, 4]],
  TAX: [[0xaa, IMP, 2]], TAY: [[0xa8, IMP, 2]], TSX: [[0xba, IMP, 2]], TXA: [[0x8a, IMP, 2]], TXS: [[0x9a, IMP, 2]], TYA: [[0x98, IMP, 2]],
  // Undocumented, stable.
  LAX: [[0xa7, ZP, 3], [0xb7, ZPY, 4], [0xaf, ABS, 4], [0xbf, ABY, 4, 1], [0xa3, IZX, 6], [0xb3, IZY, 5, 1], [0xab, IMM, 2]],
  SAX: [[0x87, ZP, 3], [0x97, ZPY, 4], [0x8f, ABS, 4], [0x83, IZX, 6]],
  DCP: [[0xc7, ZP, 5], [0xd7, ZPX, 6], [0xcf, ABS, 6], [0xdf, ABX, 7], [0xdb, ABY, 7], [0xc3, IZX, 8], [0xd3, IZY, 8]],
  ISB: [[0xe7, ZP, 5], [0xf7, ZPX, 6], [0xef, ABS, 6], [0xff, ABX, 7], [0xfb, ABY, 7], [0xe3, IZX, 8], [0xf3, IZY, 8]],
  SLO: [[0x07, ZP, 5], [0x17, ZPX, 6], [0x0f, ABS, 6], [0x1f, ABX, 7], [0x1b, ABY, 7], [0x03, IZX, 8], [0x13, IZY, 8]],
  RLA: [[0x27, ZP, 5], [0x37, ZPX, 6], [0x2f, ABS, 6], [0x3f, ABX, 7], [0x3b, ABY, 7], [0x23, IZX, 8], [0x33, IZY, 8]],
  SRE: [[0x47, ZP, 5], [0x57, ZPX, 6], [0x4f, ABS, 6], [0x5f, ABX, 7], [0x5b, ABY, 7], [0x43, IZX, 8], [0x53, IZY, 8]],
  RRA: [[0x67, ZP, 5], [0x77, ZPX, 6], [0x6f, ABS, 6], [0x7f, ABX, 7], [0x7b, ABY, 7], [0x63, IZX, 8], [0x73, IZY, 8]],
  ANC: [[0x0b, IMM, 2], [0x2b, IMM, 2]],
  ALR: [[0x4b, IMM, 2]], ARR: [[0x6b, IMM, 2]], AXS: [[0xcb, IMM, 2]],
});

export class Cpu6502 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.x = 0; this.y = 0; this.s = 0xfd; this.p = U | I; this.pc = 0;
    this.cycles = 0;
    this.error = null; // why a run stopped: an unstable opcode, a JAM
  }

  read(a) { return this.bus.read(a & 0xffff) & 0xff; }
  read16(a) { return this.read(a) | (this.read(a + 1) << 8); }
  push(v) { this.bus.write(0x100 | this.s, v & 0xff); this.s = (this.s - 1) & 0xff; }
  pull() { this.s = (this.s + 1) & 0xff; return this.read(0x100 | this.s); }
  nz(v) { this.p = (this.p & ~(N | Z)) | (v & N) | (v & 0xff ? 0 : Z); return v & 0xff; }

  /**
   * Calls the routine at `addr` as a JSR from `trap` would, and runs until
   * it returns there. The cycles it took, or -1 when it ran past `limit`
   * cycles or stopped (`error`).
   */
  call(addr, { a = this.a, x = this.x, y = this.y, trap = 0x5ff4, limit = 1e7 } = {}) {
    this.a = a & 0xff; this.x = x & 0xff; this.y = y & 0xff;
    const ret = (trap - 1) & 0xffff;
    this.push(ret >> 8);
    this.push(ret);
    this.pc = addr & 0xffff;
    const start = this.cycles;
    while (this.pc !== trap) {
      if (this.cycles - start > limit || !this.step()) return -1;
    }
    return this.cycles - start;
  }

  // The operand's address for `mode` (after the opcode), with the page-cross test.
  addr(mode) {
    let a, base;
    switch (mode) {
      case IMM: a = this.pc; this.pc = (this.pc + 1) & 0xffff; return a;
      case ZP: a = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return a;
      case ZPX: a = (this.read(this.pc) + this.x) & 0xff; this.pc = (this.pc + 1) & 0xffff; return a;
      case ZPY: a = (this.read(this.pc) + this.y) & 0xff; this.pc = (this.pc + 1) & 0xffff; return a;
      case ABS: a = this.read16(this.pc); this.pc = (this.pc + 2) & 0xffff; return a;
      case ABX: base = this.read16(this.pc); this.pc = (this.pc + 2) & 0xffff; a = (base + this.x) & 0xffff; this.crossed = (a ^ base) & 0xff00; return a;
      case ABY: base = this.read16(this.pc); this.pc = (this.pc + 2) & 0xffff; a = (base + this.y) & 0xffff; this.crossed = (a ^ base) & 0xff00; return a;
      case IZX: { const z = (this.read(this.pc) + this.x) & 0xff; this.pc = (this.pc + 1) & 0xffff; return this.read(z) | (this.read((z + 1) & 0xff) << 8); }
      case IZY: {
        const z = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff;
        base = this.read(z) | (this.read((z + 1) & 0xff) << 8);
        a = (base + this.y) & 0xffff; this.crossed = (a ^ base) & 0xff00; return a;
      }
      case IND: {
        // The 6502's page wrap: ($xxFF) reads its high byte from $xx00.
        const p = this.read16(this.pc); this.pc = (this.pc + 2) & 0xffff;
        return this.read(p) | (this.read((p & 0xff00) | ((p + 1) & 0xff)) << 8);
      }
      default: return 0;
    }
  }

  adc(v) {
    const r = this.a + v + (this.p & C);
    this.p = (this.p & ~(C | V)) | (r > 0xff ? C : 0) | (~(this.a ^ v) & (this.a ^ r) & 0x80 ? V : 0);
    this.a = this.nz(r);
  }
  cmp(reg, v) { const r = reg - v; this.p = (this.p & ~C) | (r >= 0 ? C : 0); this.nz(r); }
  asl(v) { this.p = (this.p & ~C) | (v >> 7); return this.nz(v << 1); }
  lsr(v) { this.p = (this.p & ~C) | (v & 1); return this.nz(v >> 1); }
  rol(v) { const r = (v << 1) | (this.p & C); this.p = (this.p & ~C) | (v >> 7); return this.nz(r); }
  ror(v) { const r = (v >> 1) | ((this.p & C) << 7); this.p = (this.p & ~C) | (v & 1); return this.nz(r); }

  /** One instruction; false when it cannot be run. */
  step() {
    const op = this.read(this.pc);
    const e = OPS[op];
    if (!e) { this.error = `opcode $${op.toString(16).padStart(2, "0")} at $${this.pc.toString(16).padStart(4, "0")}`; return false; }
    this.pc = (this.pc + 1) & 0xffff;
    const [name, mode, cyc, cross] = e;
    this.crossed = 0;
    this.cycles += cyc;
    if (mode === REL) {
      const off = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff;
      const f = this.p;
      const take = name === "BPL" ? !(f & N) : name === "BMI" ? f & N : name === "BVC" ? !(f & V) : name === "BVS" ? f & V
        : name === "BCC" ? !(f & C) : name === "BCS" ? f & C : name === "BNE" ? !(f & Z) : f & Z;
      if (take) {
        const to = (this.pc + (off < 0x80 ? off : off - 256)) & 0xffff;
        this.cycles += (to ^ this.pc) & 0xff00 ? 2 : 1;
        this.pc = to;
      }
      return true;
    }
    const at = mode === IMP || mode === ACC ? 0 : this.addr(mode);
    if (cross && this.crossed) this.cycles++;
    const rmw = (f) => { const v = f(this.read(at)); this.bus.write(at, v); return v; };
    switch (name) {
      case "ADC": this.adc(this.read(at)); break;
      case "SBC": this.adc(this.read(at) ^ 0xff); break;
      case "AND": this.a = this.nz(this.a & this.read(at)); break;
      case "ORA": this.a = this.nz(this.a | this.read(at)); break;
      case "EOR": this.a = this.nz(this.a ^ this.read(at)); break;
      case "ASL": if (mode === ACC) this.a = this.asl(this.a); else rmw((v) => this.asl(v)); break;
      case "LSR": if (mode === ACC) this.a = this.lsr(this.a); else rmw((v) => this.lsr(v)); break;
      case "ROL": if (mode === ACC) this.a = this.rol(this.a); else rmw((v) => this.rol(v)); break;
      case "ROR": if (mode === ACC) this.a = this.ror(this.a); else rmw((v) => this.ror(v)); break;
      case "BIT": { const v = this.read(at); this.p = (this.p & ~(N | V | Z)) | (v & (N | V)) | (v & this.a ? 0 : Z); break; }
      case "BRK": {
        const ret = (this.pc + 1) & 0xffff;
        this.push(ret >> 8); this.push(ret); this.push(this.p | B | U);
        this.p |= I;
        this.pc = this.read16(0xfffe);
        break;
      }
      case "CLC": this.p &= ~C; break;
      case "CLD": this.p &= ~D; break;
      case "CLI": this.p &= ~I; break;
      case "CLV": this.p &= ~V; break;
      case "SEC": this.p |= C; break;
      case "SED": this.p |= D; break;
      case "SEI": this.p |= I; break;
      case "CMP": this.cmp(this.a, this.read(at)); break;
      case "CPX": this.cmp(this.x, this.read(at)); break;
      case "CPY": this.cmp(this.y, this.read(at)); break;
      case "DEC": rmw((v) => this.nz(v - 1)); break;
      case "INC": rmw((v) => this.nz(v + 1)); break;
      case "DEX": this.x = this.nz(this.x - 1); break;
      case "DEY": this.y = this.nz(this.y - 1); break;
      case "INX": this.x = this.nz(this.x + 1); break;
      case "INY": this.y = this.nz(this.y + 1); break;
      case "JMP": this.pc = at; break;
      case "JSR": { const ret = (this.pc - 1) & 0xffff; this.push(ret >> 8); this.push(ret); this.pc = at; break; }
      case "RTS": this.pc = ((this.pull() | (this.pull() << 8)) + 1) & 0xffff; break;
      case "RTI": this.p = (this.pull() & ~B) | U; this.pc = this.pull() | (this.pull() << 8); break;
      case "LDA": this.a = this.nz(this.read(at)); break;
      case "LDX": this.x = this.nz(this.read(at)); break;
      case "LDY": this.y = this.nz(this.read(at)); break;
      case "STA": this.bus.write(at, this.a); break;
      case "STX": this.bus.write(at, this.x); break;
      case "STY": this.bus.write(at, this.y); break;
      case "NOP": if (mode !== IMP) this.read(at); break;
      case "PHA": this.push(this.a); break;
      case "PHP": this.push(this.p | B | U); break;
      case "PLA": this.a = this.nz(this.pull()); break;
      case "PLP": this.p = (this.pull() & ~B) | U; break;
      case "TAX": this.x = this.nz(this.a); break;
      case "TAY": this.y = this.nz(this.a); break;
      case "TSX": this.x = this.nz(this.s); break;
      case "TXA": this.a = this.nz(this.x); break;
      case "TXS": this.s = this.x; break;
      case "TYA": this.a = this.nz(this.y); break;
      case "LAX": this.a = this.x = this.nz(this.read(at)); break;
      case "SAX": this.bus.write(at, this.a & this.x); break;
      case "DCP": this.cmp(this.a, rmw((v) => (v - 1) & 0xff)); break;
      case "ISB": this.adc(rmw((v) => (v + 1) & 0xff) ^ 0xff); break;
      case "SLO": this.a = this.nz(this.a | rmw((v) => this.asl(v))); break;
      case "RLA": this.a = this.nz(this.a & rmw((v) => this.rol(v))); break;
      case "SRE": this.a = this.nz(this.a ^ rmw((v) => this.lsr(v))); break;
      case "RRA": this.adc(rmw((v) => this.ror(v))); break;
      case "ANC": this.a = this.nz(this.a & this.read(at)); this.p = (this.p & ~C) | (this.a >> 7); break;
      case "ALR": this.a = this.lsr(this.a & this.read(at)); break;
      case "ARR": {
        const r = ((this.a & this.read(at)) >> 1) | ((this.p & C) << 7);
        this.a = this.nz(r);
        this.p = (this.p & ~(C | V)) | ((r >> 6) & 1 ? C : 0) | (((r >> 6) ^ (r >> 5)) & 1 ? V : 0);
        break;
      }
      case "AXS": { const r = (this.a & this.x) - this.read(at); this.p = (this.p & ~C) | (r >= 0 ? C : 0); this.x = this.nz(r); break; }
    }
    return true;
  }
}
