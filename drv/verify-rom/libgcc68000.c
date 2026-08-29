// 32-bit multiply and divide for a 68000, because the toolchain's own are for a
// 68020.
//
// THE BUG THIS FIXES, because it cost an afternoon and will cost the next one
// too: Ubuntu's m68k-linux-gnu ships exactly one libgcc, built for 68020+.
// Its __modsi3 contains
//
//     5044: 61ff ffff ff32   bsr.l <__udivsi3>
//
// and `bsr` with a 32-bit displacement is a 68020 instruction. A 68000 decodes
// the same bytes as `bsr.s` to an ODD address and takes an address error — so
// the ROM died inside MMLisp_loadScore the first time the sequencer divided,
// with a fault address one byte past the PC and no other symptom. There is no
// -m68000 multilib to link instead (`gcc -print-multi-lib` reports only `.`),
// so these are ours.
//
// Compiled into the probe ROM only. SGDK users link SGDK's m68k-elf libgcc,
// which is built for the real target and is faster than this; nothing here is
// on any path that ships.
//
// SPEED. These are shift loops, not the 68000's MULU/DIVU. That is deliberate:
// a hand-written 32-bit divide is a subtle thing to get right, and being wrong
// here would corrupt note dispatch rather than announce itself. The cost is
// bounded — the sequencer does a few dozen of these a frame against a 896,000
// cycle 68000 frame — and the ROM measures whether the 68000 kept up (`host256`
// in probe.h) so the assumption is checked on every run rather than trusted.
//
// Nothing below may use *, / or % on a 32-bit value: the compiler would turn it
// straight back into a call to the function it appears in.

unsigned long __mulsi3(unsigned long a, unsigned long b)
{
    unsigned long r = 0;
    while (b) {
        if (b & 1UL) r += a;
        a += a;
        b >>= 1;
    }
    return r;
}

unsigned long __udivsi3(unsigned long a, unsigned long b)
{
    if (!b) return ~0UL;                     /* undefined in C; do not trap */
    unsigned long q = 0, rem = 0;
    for (int i = 31; i >= 0; i--) {
        rem = (rem << 1) | ((a >> i) & 1UL);
        if (rem >= b) { rem -= b; q |= 1UL << i; }
    }
    return q;
}

unsigned long __umodsi3(unsigned long a, unsigned long b)
{
    if (!b) return a;
    unsigned long rem = 0;
    for (int i = 31; i >= 0; i--) {
        rem = (rem << 1) | ((a >> i) & 1UL);
        if (rem >= b) rem -= b;
    }
    return rem;
}

// C99: division truncates toward zero and the remainder takes the sign of the
// DIVIDEND. Doing the magnitudes unsigned and reapplying the signs is the only
// way to get both right without special-casing LONG_MIN, whose negation
// overflows — as an unsigned magnitude it is simply 0x80000000.
static unsigned long mag(long v) { return v < 0 ? -(unsigned long)v : (unsigned long)v; }

long __divsi3(long a, long b)
{
    unsigned long q = __udivsi3(mag(a), mag(b));
    return ((a < 0) != (b < 0)) ? -(long)q : (long)q;
}

long __modsi3(long a, long b)
{
    unsigned long r = __umodsi3(mag(a), mag(b));
    return (a < 0) ? -(long)r : (long)r;
}
