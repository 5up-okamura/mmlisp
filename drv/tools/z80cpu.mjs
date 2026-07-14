// Minimal Z80 CPU emulator — first-party, zero dependencies.
//
// Implements exactly the instruction subset drv/tools/z80asm.mjs can emit
// (documented Z80 behavior, standard flags; undocumented X/Y flag bits are
// not modeled). Any opcode outside the subset throws — that is deliberate:
// assembler and emulator are developed in lockstep, and an unexpected byte
// means a real bug, not something to limp past.
//
// Timing is NOT cycle-accurate (the M1 trace harness is frame-driven, not
// cycle-driven); step() returns rough documented cycle counts for later
// budget estimates only.
//
// Interrupts: IM 1 only (Mega Drive Z80 vblank). intRequest() latches a
// pending maskable interrupt which is accepted when IFF1 is set (with the
// standard one-instruction EI delay), pushing PC and jumping to 0x38.

const FLAG_C = 0x01;
const FLAG_N = 0x02;
const FLAG_PV = 0x04;
const FLAG_H = 0x10;
const FLAG_Z = 0x40;
const FLAG_S = 0x80;

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 1;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) p ^= 1;
  PARITY[i] = p ? FLAG_PV : 0;
}

export class Z80Cpu {
  constructor({ read, write }) {
    this.read = read;
    this.write = write;
    this.reset();
  }

  reset() {
    this.a = 0; this.f = 0;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0;
    this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0; this.iy = 0;
    this.sp = 0xffff;
    this.pc = 0;
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.halted = false;
    this.eiDelay = false;
    this.intPending = false;
    // Lowest SP ever reached (stack watermark, tools/budget.mjs). Pushes before
    // the driver's `ld sp,STACK_TOP` sit near 0xFFFF, so the real stack minimum
    // (near 0x1Fxx) naturally wins the min and pre-setup pushes don't pollute it.
    this.spMin = this.sp;
  }

  intRequest() {
    this.intPending = true;
  }

  // ── register pair helpers ────────────────────────────────────────────────
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }

  fetch() {
    const b = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return b;
  }
  fetch16() {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }
  push16(v) {
    this.sp = (this.sp - 1) & 0xffff;
    this.write(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.write(this.sp, v & 0xff);
    if (this.sp < this.spMin) this.spMin = this.sp;
  }
  pop16() {
    const lo = this.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  // ── flag helpers ─────────────────────────────────────────────────────────
  szFlags(v) {
    return (v & 0x80 ? FLAG_S : 0) | (v === 0 ? FLAG_Z : 0);
  }
  add8(a, b, carry) {
    const c = carry ? 1 : 0;
    const r = a + b + c;
    const rb = r & 0xff;
    this.f =
      this.szFlags(rb) |
      ((a ^ b ^ rb) & 0x10 ? FLAG_H : 0) |
      (~(a ^ b) & (a ^ rb) & 0x80 ? FLAG_PV : 0) |
      (r > 0xff ? FLAG_C : 0);
    return rb;
  }
  sub8(a, b, carry) {
    const c = carry ? 1 : 0;
    const r = a - b - c;
    const rb = r & 0xff;
    this.f =
      this.szFlags(rb) |
      FLAG_N |
      ((a ^ b ^ rb) & 0x10 ? FLAG_H : 0) |
      ((a ^ b) & (a ^ rb) & 0x80 ? FLAG_PV : 0) |
      (r < 0 ? FLAG_C : 0);
    return rb;
  }
  logic(v, hFlag) {
    this.a = v & 0xff;
    this.f = this.szFlags(this.a) | PARITY[this.a] | (hFlag ? FLAG_H : 0);
  }
  inc8(v) {
    const r = (v + 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      this.szFlags(r) |
      ((v & 0x0f) === 0x0f ? FLAG_H : 0) |
      (v === 0x7f ? FLAG_PV : 0);
    return r;
  }
  dec8(v) {
    const r = (v - 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      FLAG_N |
      this.szFlags(r) |
      ((v & 0x0f) === 0 ? FLAG_H : 0) |
      (v === 0x80 ? FLAG_PV : 0);
    return r;
  }
  add16(a, b) {
    const r = a + b;
    this.f =
      (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) |
      ((a ^ b ^ r) & 0x1000 ? FLAG_H : 0) |
      (r > 0xffff ? FLAG_C : 0);
    return r & 0xffff;
  }
  adc16(a, b) {
    const c = this.f & FLAG_C ? 1 : 0;
    const r = a + b + c;
    const rw = r & 0xffff;
    this.f =
      (rw & 0x8000 ? FLAG_S : 0) |
      (rw === 0 ? FLAG_Z : 0) |
      ((a ^ b ^ rw) & 0x1000 ? FLAG_H : 0) |
      (~(a ^ b) & (a ^ rw) & 0x8000 ? FLAG_PV : 0) |
      (r > 0xffff ? FLAG_C : 0);
    return rw;
  }
  sbc16(a, b) {
    const c = this.f & FLAG_C ? 1 : 0;
    const r = a - b - c;
    const rw = r & 0xffff;
    this.f =
      FLAG_N |
      (rw & 0x8000 ? FLAG_S : 0) |
      (rw === 0 ? FLAG_Z : 0) |
      ((a ^ b ^ rw) & 0x1000 ? FLAG_H : 0) |
      ((a ^ b) & (a ^ rw) & 0x8000 ? FLAG_PV : 0) |
      (r < 0 ? FLAG_C : 0);
    return rw;
  }
  cond(code) {
    switch (code) {
      case 0: return !(this.f & FLAG_Z);
      case 1: return !!(this.f & FLAG_Z);
      case 2: return !(this.f & FLAG_C);
      case 3: return !!(this.f & FLAG_C);
      case 4: return !(this.f & FLAG_PV);
      case 5: return !!(this.f & FLAG_PV);
      case 6: return !(this.f & FLAG_S);
      case 7: return !!(this.f & FLAG_S);
    }
  }
  getR(code) {
    switch (code) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.read(this.hl);
      case 7: return this.a;
    }
  }
  setR(code, v) {
    v &= 0xff;
    switch (code) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.write(this.hl, v); break;
      case 7: this.a = v; break;
    }
  }
  getRP(code) {
    switch (code) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      case 3: return this.sp;
    }
  }
  setRP(code, v) {
    switch (code) {
      case 0: this.bc = v; break;
      case 1: this.de = v; break;
      case 2: this.hl = v; break;
      case 3: this.sp = v; break;
    }
  }

  aluOp(op, v) {
    switch (op) {
      case 0: this.a = this.add8(this.a, v, false); break;
      case 1: this.a = this.add8(this.a, v, this.f & FLAG_C); break;
      case 2: this.a = this.sub8(this.a, v, false); break;
      case 3: this.a = this.sub8(this.a, v, this.f & FLAG_C); break;
      case 4: this.logic(this.a & v, true); break;
      case 5: this.logic(this.a ^ v, false); break;
      case 6: this.logic(this.a | v, false); break;
      case 7: { const a = this.a; this.sub8(a, v, false); this.a = a; break; }
    }
  }

  rotOp(op, v) {
    let r;
    let c;
    switch (op) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break; // rlc
      case 1: c = v & 1; r = ((v >> 1) | (c << 7)) & 0xff; break; // rrc
      case 2: c = v >> 7; r = ((v << 1) | (this.f & FLAG_C ? 1 : 0)) & 0xff; break; // rl
      case 3: c = v & 1; r = ((v >> 1) | (this.f & FLAG_C ? 0x80 : 0)) & 0xff; break; // rr
      case 4: c = v >> 7; r = (v << 1) & 0xff; break; // sla
      case 5: c = v & 1; r = ((v >> 1) | (v & 0x80)) & 0xff; break; // sra
      case 7: c = v & 1; r = v >> 1; break; // srl
      default: throw new Error(`unsupported CB rot op ${op}`);
    }
    this.f = this.szFlags(r) | PARITY[r] | (c ? FLAG_C : 0);
    return r;
  }

  // ── interrupt acceptance ────────────────────────────────────────────────
  maybeInterrupt() {
    if (!this.intPending || this.eiDelay || !this.iff1) return false;
    this.intPending = false;
    this.iff1 = this.iff2 = false;
    if (this.halted) {
      this.halted = false;
    }
    if (this.im !== 1) throw new Error(`only IM 1 supported (im=${this.im})`);
    this.push16(this.pc);
    this.pc = 0x38;
    return true;
  }

  /** Execute one instruction (or accept a pending interrupt). */
  step() {
    if (this.maybeInterrupt()) return 13;
    this.eiDelay = false;
    if (this.halted) return 4;

    const op = this.fetch();
    switch (op) {
      case 0x00: return 4; // nop
      case 0x76: this.halted = true; return 4;
      case 0xf3: this.iff1 = this.iff2 = false; return 4;
      case 0xfb: this.iff1 = this.iff2 = true; this.eiDelay = true; return 4;

      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_C : 0); return 4; }
      case 0x0f: { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_C : 0); return 4; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & FLAG_C ? 1 : 0)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_C : 0); return 4; }
      case 0x1f: { const c = this.a & 1; this.a = ((this.a >> 1) | (this.f & FLAG_C ? 0x80 : 0)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_C : 0); return 4; }
      case 0x2f: this.a = ~this.a & 0xff; this.f |= FLAG_H | FLAG_N; return 4;
      case 0x37: this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | FLAG_C; return 4;
      case 0x3f: { const c = this.f & FLAG_C;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_H : FLAG_C); return 4; }

      case 0x02: this.write(this.bc, this.a); return 7;
      case 0x12: this.write(this.de, this.a); return 7;
      case 0x0a: this.a = this.read(this.bc); return 7;
      case 0x1a: this.a = this.read(this.de); return 7;
      case 0x32: this.write(this.fetch16(), this.a); return 13;
      case 0x3a: this.a = this.read(this.fetch16()); return 13;
      case 0x22: { const addr = this.fetch16(); this.write(addr, this.l);
        this.write((addr + 1) & 0xffff, this.h); return 16; }
      case 0x2a: { const addr = this.fetch16(); this.l = this.read(addr);
        this.h = this.read((addr + 1) & 0xffff); return 16; }
      case 0xf9: this.sp = this.hl; return 6;

      case 0x08: { const a = this.a, f = this.f;
        this.a = this.a_; this.f = this.f_; this.a_ = a; this.f_ = f; return 4; }
      case 0xd9: { let t;
        t = this.b; this.b = this.b_; this.b_ = t;
        t = this.c; this.c = this.c_; this.c_ = t;
        t = this.d; this.d = this.d_; this.d_ = t;
        t = this.e; this.e = this.e_; this.e_ = t;
        t = this.h; this.h = this.h_; this.h_ = t;
        t = this.l; this.l = this.l_; this.l_ = t; return 4; }
      case 0xeb: { const de = this.de; this.de = this.hl; this.hl = de; return 4; }
      case 0xe3: { const v = this.read(this.sp) | (this.read((this.sp + 1) & 0xffff) << 8);
        this.write(this.sp, this.l); this.write((this.sp + 1) & 0xffff, this.h);
        this.hl = v; return 19; }

      case 0xc3: this.pc = this.fetch16(); return 10;
      case 0xe9: this.pc = this.hl; return 4;
      case 0x18: { const d = this.fetch(); this.pc = (this.pc + ((d << 24) >> 24)) & 0xffff; return 12; }
      case 0x10: { const d = this.fetch(); this.b = (this.b - 1) & 0xff;
        if (this.b) { this.pc = (this.pc + ((d << 24) >> 24)) & 0xffff; return 13; } return 8; }
      case 0xcd: { const addr = this.fetch16(); this.push16(this.pc); this.pc = addr; return 17; }
      case 0xc9: this.pc = this.pop16(); return 10;

      default: break;
    }

    // jr cc / ld rp,nn / add hl,rp / inc/dec rp / ld r,n / alu / ld r,r' etc.
    if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) {
      const d = this.fetch();
      if (this.cond((op - 0x20) >> 3)) {
        this.pc = (this.pc + ((d << 24) >> 24)) & 0xffff;
        return 12;
      }
      return 7;
    }
    if ((op & 0xcf) === 0x01) { this.setRP((op >> 4) & 3, this.fetch16()); return 10; }
    if ((op & 0xcf) === 0x09) { this.hl = this.add16(this.hl, this.getRP((op >> 4) & 3)); return 11; }
    if ((op & 0xcf) === 0x03) { const p = (op >> 4) & 3; this.setRP(p, (this.getRP(p) + 1) & 0xffff); return 6; }
    if ((op & 0xcf) === 0x0b) { const p = (op >> 4) & 3; this.setRP(p, (this.getRP(p) - 1) & 0xffff); return 6; }
    if ((op & 0xc7) === 0x04) { const r = (op >> 3) & 7; this.setR(r, this.inc8(this.getR(r))); return r === 6 ? 11 : 4; }
    if ((op & 0xc7) === 0x05) { const r = (op >> 3) & 7; this.setR(r, this.dec8(this.getR(r))); return r === 6 ? 11 : 4; }
    if ((op & 0xc7) === 0x06) { this.setR((op >> 3) & 7, this.fetch()); return 7; }
    if (op >= 0x40 && op <= 0x7f) { // ld r,r' (0x76 handled above)
      this.setR((op >> 3) & 7, this.getR(op & 7));
      return 4;
    }
    if (op >= 0x80 && op <= 0xbf) { this.aluOp((op >> 3) & 7, this.getR(op & 7)); return 4; }
    if ((op & 0xc7) === 0xc6) { this.aluOp((op >> 3) & 7, this.fetch()); return 7; }
    if ((op & 0xc7) === 0xc2) { const addr = this.fetch16();
      if (this.cond((op >> 3) & 7)) this.pc = addr; return 10; }
    if ((op & 0xc7) === 0xc4) { const addr = this.fetch16();
      if (this.cond((op >> 3) & 7)) { this.push16(this.pc); this.pc = addr; return 17; } return 10; }
    if ((op & 0xc7) === 0xc0) { if (this.cond((op >> 3) & 7)) { this.pc = this.pop16(); return 11; } return 5; }
    if ((op & 0xc7) === 0xc7) { this.push16(this.pc); this.pc = op & 0x38; return 11; }
    if ((op & 0xcf) === 0xc5) { const p = (op >> 4) & 3;
      this.push16(p === 3 ? this.af : this.getRP(p)); return 11; }
    if ((op & 0xcf) === 0xc1) { const p = (op >> 4) & 3; const v = this.pop16();
      if (p === 3) this.af = v; else this.setRP(p, v); return 10; }

    if (op === 0xcb) return this.stepCB();
    if (op === 0xed) return this.stepED();
    if (op === 0xdd) return this.stepIndex("ix");
    if (op === 0xfd) return this.stepIndex("iy");

    throw new Error(`unimplemented opcode 0x${op.toString(16)} at ${(this.pc - 1) & 0xffff}`);
  }

  stepCB() {
    const op = this.fetch();
    const r = op & 7;
    const kind = op >> 6;
    if (kind === 0) { // rot/shift
      this.setR(r, this.rotOp((op >> 3) & 7, this.getR(r)));
      return r === 6 ? 15 : 8;
    }
    const bit = (op >> 3) & 7;
    if (kind === 1) { // bit
      const v = this.getR(r) & (1 << bit);
      this.f = (this.f & FLAG_C) | FLAG_H | (v ? 0 : FLAG_Z | FLAG_PV) |
        (bit === 7 && v ? FLAG_S : 0);
      return r === 6 ? 12 : 8;
    }
    if (kind === 3) { this.setR(r, this.getR(r) | (1 << bit)); return r === 6 ? 15 : 8; } // set
    this.setR(r, this.getR(r) & ~(1 << bit)); // res
    return r === 6 ? 15 : 8;
  }

  stepED() {
    const op = this.fetch();
    if (op === 0x44) { const a = this.a; this.a = this.sub8(0, a, false); return 8; } // neg
    if (op === 0x4d) { this.pc = this.pop16(); return 14; } // reti
    if (op === 0x45) { this.iff1 = this.iff2; this.pc = this.pop16(); return 14; } // retn
    if (op === 0x46) { this.im = 0; return 8; }
    if (op === 0x56) { this.im = 1; return 8; }
    if (op === 0x5e) { this.im = 2; return 8; }
    if ((op & 0xcf) === 0x43) { const addr = this.fetch16(); const v = this.getRP((op >> 4) & 3);
      this.write(addr, v & 0xff); this.write((addr + 1) & 0xffff, v >> 8); return 20; }
    if ((op & 0xcf) === 0x4b) { const addr = this.fetch16();
      this.setRP((op >> 4) & 3, this.read(addr) | (this.read((addr + 1) & 0xffff) << 8)); return 20; }
    if ((op & 0xcf) === 0x4a) { this.hl = this.adc16(this.hl, this.getRP((op >> 4) & 3)); return 15; }
    if ((op & 0xcf) === 0x42) { this.hl = this.sbc16(this.hl, this.getRP((op >> 4) & 3)); return 15; }
    if (op === 0xa0 || op === 0xa8 || op === 0xb0 || op === 0xb8) {
      // ldi / ldd / ldir / lddr
      const dir = op & 0x08 ? -1 : 1;
      const repeat = op & 0x10;
      do {
        this.write(this.de, this.read(this.hl));
        this.hl = (this.hl + dir) & 0xffff;
        this.de = (this.de + dir) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
      } while (repeat && this.bc !== 0);
      this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_C)) | (this.bc !== 0 ? FLAG_PV : 0);
      return 16;
    }
    throw new Error(`unimplemented ED opcode 0x${op.toString(16)}`);
  }

  stepIndex(name) {
    const get = () => this[name];
    const set = (v) => { this[name] = v & 0xffff; };
    const op = this.fetch();
    if (op === 0xcb) {
      // DDCB/FDCB: displacement byte precedes the sub-opcode. Only the
      // (ix+d) bit/set/res forms are supported (what the assembler emits).
      const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
      const sub = this.fetch();
      const bit = (sub >> 3) & 7;
      const kind = sub >> 6;
      if ((sub & 7) !== 6 || kind === 0)
        throw new Error(`unsupported DDCB sub-opcode 0x${sub.toString(16)}`);
      if (kind === 1) {
        const v = this.read(addr) & (1 << bit);
        this.f = (this.f & FLAG_C) | FLAG_H | (v ? 0 : FLAG_Z | FLAG_PV) |
          (bit === 7 && v ? FLAG_S : 0);
        return 20;
      }
      if (kind === 3) this.write(addr, this.read(addr) | (1 << bit));
      else this.write(addr, this.read(addr) & ~(1 << bit));
      return 23;
    }
    switch (op) {
      case 0x21: set(this.fetch16()); return 14;
      case 0x22: { const addr = this.fetch16(); const v = get();
        this.write(addr, v & 0xff); this.write((addr + 1) & 0xffff, v >> 8); return 20; }
      case 0x2a: { const addr = this.fetch16();
        set(this.read(addr) | (this.read((addr + 1) & 0xffff) << 8)); return 20; }
      case 0x23: set(get() + 1); return 10;
      case 0x2b: set(get() - 1); return 10;
      case 0x29: set(this.add16(get(), get())); return 15;
      case 0x09: set(this.add16(get(), this.bc)); return 15;
      case 0x19: set(this.add16(get(), this.de)); return 15;
      case 0x39: set(this.add16(get(), this.sp)); return 15;
      case 0xe5: this.push16(get()); return 15;
      case 0xe1: set(this.pop16()); return 14;
      case 0xf9: this.sp = get(); return 10;
      case 0x34: { const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
        this.write(addr, this.inc8(this.read(addr))); return 23; }
      case 0x35: { const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
        this.write(addr, this.dec8(this.read(addr))); return 23; }
      case 0x36: { const d = (this.fetch() << 24) >> 24; const v = this.fetch();
        this.write((get() + d) & 0xffff, v); return 19; }
      default: break;
    }
    if ((op & 0xc7) === 0x46 && op !== 0x76) { // ld r,(ix+d)
      const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
      this.setR((op >> 3) & 7, this.read(addr));
      return 19;
    }
    if (op >= 0x70 && op <= 0x77 && op !== 0x76) { // ld (ix+d),r
      const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
      this.write(addr, this.getR(op & 7));
      return 19;
    }
    if (op >= 0x80 && op <= 0xbf && (op & 7) === 6) { // alu a,(ix+d)
      const addr = (get() + ((this.fetch() << 24) >> 24)) & 0xffff;
      this.aluOp((op >> 3) & 7, this.read(addr));
      return 19;
    }
    throw new Error(`unimplemented ${name.toUpperCase()} opcode 0x${op.toString(16)}`);
  }
}
