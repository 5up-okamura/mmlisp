// The SGDK-shaped runtime this ROM needs, and nothing else.
//
// mmlispdrv.c is driver-owned source that a user's SGDK project compiles as-is
// (drv/sgdk/README.md). This file supplies the handful of SGDK calls it makes,
// against the real hardware registers, so that the SAME file runs here — the
// point of the ROM is to measure the shipped glue, not a copy of it.
//
// Where SGDK's behaviour is load-bearing the comment says so; where this is
// merely the smallest thing that works, it says that too.
#include "genesis.h"

#define Z80_BUSREQ   (*(vu16 *)0x00A11100)
#define Z80_RESET    (*(vu16 *)0x00A11200)
#define VDP_CTRL     (*(vu16 *)0x00C00004)

vu32 vtimer;                // incremented by _int_v in boot.s

// SGDK keeps a nesting depth so that a disable inside a disable does not
// re-enable early. mmlispdrv.c only ever nests one deep, but matching the
// semantics costs two instructions and removes a way for this file to be
// subtly different from the one being modelled.
static s16 int_depth;

void SYS_disableInts(void)
{
    if (!int_depth++) __asm__ volatile ("move.w #0x2700, %%sr" ::: "cc");
}

void SYS_enableInts(void)
{
    if (int_depth > 0 && !--int_depth) __asm__ volatile ("move.w #0x2000, %%sr" ::: "cc");
}

// SGDK's own order: assert BUSREQ *and* lift reset, then spin until the bus is
// granted. Requesting the bus of a Z80 held in reset never completes, which is
// the bring-up bug this ordering exists to prevent.
void Z80_requestBus(bool wait)
{
    Z80_BUSREQ = 0x0100;
    Z80_RESET  = 0x0100;
    if (wait) while (Z80_BUSREQ & 0x0100) ;
}

void Z80_releaseBus(void)  { Z80_BUSREQ = 0x0000; }
void Z80_startReset(void)  { Z80_RESET  = 0x0000; }
void Z80_endReset(void)    { Z80_RESET  = 0x0100; }

// Called with the bus already held (MMLisp_init takes it first). Byte writes
// only: the Z80's bus is 8 bits and a word access to its RAM is undefined.
void Z80_clear(void)
{
    vu8 *p = (vu8 *)Z80_RAM_START;
    for (u16 i = 0; i < 0x2000; i++) p[i] = 0;
}

void Z80_upload(const u16 dest, const u8 *data, const u16 size)
{
    vu8 *p = (vu8 *)(Z80_RAM_START + dest);
    for (u16 i = 0; i < size; i++) p[i] = data[i];
}

// A busy wait, because this is called with interrupts off (mmlispdrv.c holds
// the Z80 in reset across it) so there is no clock to read. One subtick is
// 1/2560 s ~ 2,996 cycles of a 7.67 MHz 68000; the loop below is a handful of
// cycles an iteration and the only caller wants "at least this long", not a
// measurement.
void waitSubTick(u32 subtick)
{
    for (u32 i = 0; i < subtick; i++)
        for (volatile u16 j = 0; j < 300; j++) ;
}

// ── VDP text, for a run someone watches ────────────────────────────────────
// The probe reads its numbers out of work RAM, so nothing here is needed to
// MEASURE anything. It is here because a ROM that draws nothing is a ROM you
// cannot sanity-check by looking at it, and this one is meant to be openable in
// a desktop emulator when a number looks wrong.
#define VDP_DATA     (*(vu16 *)0x00C00000)
#define PLANE_A      0xC000
#define FONT_TILE    1

static const u8 font[][8] = {
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // ' '
    {0x3C,0x66,0x6E,0x76,0x66,0x66,0x3C,0x00}, // 0
    {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00}, // 1
    {0x3C,0x66,0x06,0x0C,0x18,0x30,0x7E,0x00}, // 2
    {0x3C,0x66,0x06,0x1C,0x06,0x66,0x3C,0x00}, // 3
    {0x0C,0x1C,0x3C,0x6C,0x7E,0x0C,0x0C,0x00}, // 4
    {0x7E,0x60,0x7C,0x06,0x06,0x66,0x3C,0x00}, // 5
    {0x1C,0x30,0x60,0x7C,0x66,0x66,0x3C,0x00}, // 6
    {0x7E,0x06,0x0C,0x18,0x30,0x30,0x30,0x00}, // 7
    {0x3C,0x66,0x66,0x3C,0x66,0x66,0x3C,0x00}, // 8
    {0x3C,0x66,0x66,0x3E,0x06,0x0C,0x38,0x00}, // 9
    {0x3C,0x66,0x66,0x7E,0x66,0x66,0x66,0x00}, // A
    {0x7C,0x66,0x66,0x7C,0x66,0x66,0x7C,0x00}, // B
    {0x3C,0x66,0x60,0x60,0x60,0x66,0x3C,0x00}, // C
    {0x78,0x6C,0x66,0x66,0x66,0x6C,0x78,0x00}, // D
    {0x7E,0x60,0x60,0x7C,0x60,0x60,0x7E,0x00}, // E
    {0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x00}, // F
};
#define FONT_GLYPHS  (sizeof(font) / sizeof(font[0]))

// One nibble per tile, 4bpp: every pixel is either colour 0 or colour 1.
void VDP_uploadFont(void)
{
    VDP_CTRL = 0x8F02;                                  // auto-increment 2
    // The VRAM address is built the long way, per glyph, because the compact
    // form is easy to get wrong and silently draws the wrong tiles.
    for (u16 g = 0; g < FONT_GLYPHS; g++) {
        u32 addr = (FONT_TILE + g) * 32;
        *(vu32 *)0x00C00004 = 0x40000000 | ((addr & 0x3FFF) << 16) | ((addr >> 14) & 3);
        for (u16 row = 0; row < 8; row++) {
            u8 bits = font[g][row];
            u32 px = 0;
            for (u16 b = 0; b < 8; b++) px |= (u32)((bits >> (7 - b)) & 1) << ((7 - b) * 4);
            VDP_DATA = px >> 16;
            VDP_DATA = px & 0xFFFF;
        }
    }
    // Colour 1 = white, so the text is visible on the colour-0 backdrop.
    VDP_CTRL = 0x8700;
    *(vu32 *)0x00C00004 = 0xC0000000;                   // CRAM write, address 0
    VDP_DATA = 0x0000;
    VDP_DATA = 0x0EEE;
}

static u16 glyph_of(char c)
{
    if (c >= '0' && c <= '9') return FONT_TILE + 1 + (c - '0');
    if (c >= 'A' && c <= 'F') return FONT_TILE + 11 + (c - 'A');
    return FONT_TILE;                                   // everything else is blank
}

void VDP_drawText(const char *s, u16 x, u16 y)
{
    u32 addr = PLANE_A + (y * 64 + x) * 2;
    *(vu32 *)0x00C00004 = 0x40000000 | ((addr & 0x3FFF) << 16) | ((addr >> 14) & 3);
    for (; *s; s++) VDP_DATA = glyph_of(*s);
}

void drawHex(u32 v, u16 digits, u16 x, u16 y)
{
    char buf[9];
    for (u16 i = 0; i < digits; i++)
        buf[digits - 1 - i] = "0123456789ABCDEF"[(v >> (4 * i)) & 0xF];
    buf[digits] = 0;
    VDP_drawText(buf, x, y);
}

// The main loop's frame boundary. Under SGDK this is SYS_doVBlankProcess();
// here it is only the wait, because there is no DMA queue and no sprite list to
// flush. Spinning on vtimer means a frame the loop overran is still counted by
// the interrupt — which is the property the whole `music` measurement rests on.
void waitVBlank(void)
{
    u32 t = vtimer;
    while (vtimer == t) ;   // vtimer is vu32: without that this never returns
}
