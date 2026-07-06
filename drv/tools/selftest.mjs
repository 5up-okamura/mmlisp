// Self-test for the first-party assembler (z80asm) + emulator (z80cpu):
// 1. encoding spot-checks against hand-assembled byte sequences;
// 2. behavioral programs whose results are asserted from JS;
// 3. IM 1 interrupt / halt-loop plumbing (the driver's frame model).
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./z80asm.mjs";
import { Z80Cpu } from "./z80cpu.mjs";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok    ${name}`);
  } else {
    console.log(`FAIL  ${name}\n  actual:   ${a}\n  expected: ${e}`);
    failures++;
  }
}

const dir = mkdtempSync(join(tmpdir(), "z80test-"));
function asm(src) {
  const path = join(dir, `t${Math.abs(hash(src))}.z80`);
  writeFileSync(path, src);
  return assemble(path).bytes;
}
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// ── 1. encoding spot-checks ────────────────────────────────────────────────
check("ld/alu/jr encodings", [...asm(`
    org 0
    ld a,$12
    ld b,a
    ld hl,$1234
    ld (hl),b
    ld a,(hl)
    ld e,(hl)
    ld (hl),$56
    inc hl
    dec bc
    add hl,de
    add a,b
    sub c
    and $0f
    or a
    xor a
    cp $2a
loop:
    djnz loop
    jr loop
    jr nz,loop
    jp loop
    call loop
    ret
    ret z
`)], [
  0x3e, 0x12, 0x47, 0x21, 0x34, 0x12, 0x70, 0x7e, 0x5e, 0x36, 0x56,
  0x23, 0x0b, 0x19, 0x80, 0x91, 0xe6, 0x0f, 0xb7, 0xaf, 0xfe, 0x2a,
  0x10, 0xfe, 0x18, 0xfc, 0x20, 0xfa, 0xc3, 0x16, 0x00, 0xcd, 0x16, 0x00,
  0xc9, 0xc8,
]);

check("ix/ed/cb encodings", [...asm(`
    org 0
    ld ix,$1480
    ld a,(ix+4)
    ld (ix+14),e
    ld (ix+10),$22
    inc (ix+28)
    ld bc,($16e0)
    ld ($16e0),bc
    sbc hl,de
    adc hl,bc
    neg
    ldir
    bit 0,a
    set 7,(hl)
    res 1,c
    srl h
    rr l
    rlca
    ex de,hl
    push ix
    pop af
    im 1
    ei
    reti
`)], [
  0xdd, 0x21, 0x80, 0x14, 0xdd, 0x7e, 0x04, 0xdd, 0x73, 0x0e,
  0xdd, 0x36, 0x0a, 0x22, 0xdd, 0x34, 0x1c,
  0xed, 0x4b, 0xe0, 0x16, 0xed, 0x43, 0xe0, 0x16,
  0xed, 0x52, 0xed, 0x4a, 0xed, 0x44, 0xed, 0xb0,
  0xcb, 0x47, 0xcb, 0xfe, 0xcb, 0x89, 0xcb, 0x3c, 0xcb, 0x1d,
  0x07, 0xeb, 0xdd, 0xe5, 0xf1, 0xed, 0x56, 0xfb, 0xed, 0x4d,
]);

check("db/dw/ds/equ/expr", [...asm(`
VAL equ $1234
    org 0
    db 1, 2, "AB", 'c', VAL & $ff, VAL >> 8, %1010, 3+4*2, (3+4)*2, LATER
    dw VAL, LATER, $ - 2
    ds 3, $ee
LATER: db $99
`)], [
  1, 2, 0x41, 0x42, 0x63, 0x34, 0x12, 10, 11, 14, 20,
  0x34, 0x12, 20, 0x00, 13, 0x00,
  0xee, 0xee, 0xee, 0x99,
]);

// ── 2. behavioral runs ─────────────────────────────────────────────────────
function run(src, { maxSteps = 200000, ram = 0x10000 } = {}) {
  const bytes = asm(src);
  const mem = new Uint8Array(ram);
  mem.set(bytes, 0);
  const cpu = new Z80Cpu({
    read: (a) => mem[a],
    write: (a, v) => {
      mem[a] = v;
    },
  });
  let steps = 0;
  while (!cpu.halted && steps++ < maxSteps) cpu.step();
  if (!cpu.halted) throw new Error("program did not halt");
  return { mem, cpu };
}

{
  // 16-bit compare/loop/table lookup: sum LUT[0..4] into (0x9000),
  // find 12*q+r decomposition of 130 (q→0x9002, r→0x9003).
  const { mem } = run(`
    org 0
    ld sp,$fff0
    ld hl,0
    ld b,5
    ld de,LUT
sum:
    ld a,(de)
    inc de
    push de
    ld e,a
    ld d,0
    add hl,de
    pop de
    djnz sum
    ld ($9000),hl
    ; 130 = 12q + r
    ld a,130
    ld c,0
div12:
    cp 12
    jr c,divdone
    sub 12
    inc c
    jr div12
divdone:
    ld ($9002),a  ; wait, a is remainder
    ld a,c
    ld ($9003),a
    halt
LUT: db 10,20,30,40,55
  `);
  check("sum LUT", mem[0x9000] | (mem[0x9001] << 8), 155);
  check("div12 r", mem[0x9002], 130 % 12);
  check("div12 q", mem[0x9003], Math.trunc(130 / 12));
}

{
  // IX structure access + 16-bit inc/dec + sbc-based compare.
  const { mem } = run(`
    org 0
    ld sp,$fff0
    ld ix,$9100
    ld (ix+0),$34
    ld (ix+1),$12
    ld l,(ix+0)
    ld h,(ix+1)
    ld de,$0234
    or a
    sbc hl,de       ; $1234-$0234 = $1000
    ld ($9200),hl
    ; acc consume loop: acc=$0333, consume while >= $100
    ld hl,$0333
    ld b,0
consume:
    ld a,h
    or a
    jr z,done
    dec h
    inc b
    jr consume
done:
    ld ($9202),hl
    ld a,b
    ld ($9204),a
    halt
  `);
  check("sbc hl", mem[0x9200] | (mem[0x9201] << 8), 0x1000);
  check("acc consume rest", mem[0x9202] | (mem[0x9203] << 8), 0x33);
  check("acc consume ticks", mem[0x9204], 3);
}

{
  // Signed/rounding helpers used by level composition:
  // (off4 + 2) >> 2 with off4 = 331+160+0 = 491 → 123.
  const { mem } = run(`
    org 0
    ld sp,$fff0
    ld hl,491
    ld de,2
    add hl,de
    srl h
    rr l
    srl h
    rr l
    ld ($9300),hl
    halt
  `);
  check("round4", mem[0x9300] | (mem[0x9301] << 8), Math.trunc((491 + 2) / 4));
}

{
  // DDCB/FDCB indexed bit ops (assembler + CPU).
  const { mem } = run(`
    org 0
    ld sp,$fff0
    ld iy,$9500
    ld (iy+0),0
    set 0,(iy+0)
    set 7,(iy+0)
    res 7,(iy+0)
    bit 0,(iy+0)
    jr z,fail
    bit 1,(iy+0)
    jr nz,fail
    ld a,1
    ld ($9501),a
fail:
    halt
  `);
  check("ddcb set/res", mem[0x9500], 1);
  check("ddcb bit flags", mem[0x9501], 1);
}

// ── 3. interrupts: IM 1, halt loop, EI delay ───────────────────────────────
{
  const bytes = asm(`
    org 0
    di
    im 1
    ld sp,$fff0
    xor a
    ld ($9400),a
    ei
main:
    halt
    jr main

    org $38
    push af
    ld a,($9400)
    inc a
    ld ($9400),a
    pop af
    ei
    reti
  `);
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0);
  const cpu = new Z80Cpu({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  // boot until halted
  let steps = 0;
  while (!cpu.halted && steps++ < 1000) cpu.step();
  check("halted after boot", cpu.halted, true);
  for (let frame = 0; frame < 5; frame++) {
    cpu.intRequest();
    let s = 0;
    while (s++ < 1000) {
      cpu.step();
      if (cpu.halted && !cpu.intPending) break;
    }
  }
  check("int counter after 5 frames", mem[0x9400], 5);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall ok");
process.exit(failures ? 1 : 0);
