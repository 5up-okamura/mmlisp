/* Minimal stand-in for SGDK's <genesis.h>, for the glue type-check ONLY
 * (tools/sgdk-lint.mjs).
 *
 * This is NOT an SGDK model and a clean run says NOTHING about behaviour on
 * hardware. It exists so that mmlispdrv.c is compiled against the real
 * mmlispseq.h: a wrong argument, a renamed call or a changed type in the
 * sequencer API is a compile error here instead of a surprise in someone's
 * SGDK build. Every signature below is copied from SGDK ~1.6x.
 */
#ifndef SGDK_SHIM_GENESIS_H
#define SGDK_SHIM_GENESIS_H
#include "types.h"

#define TICKPERSECOND     256
#define SUBTICKPERSECOND  2560
#define Z80_RAM_START     0xA00000

void Z80_requestBus(bool wait);
void Z80_releaseBus(void);
void Z80_startReset(void);
void Z80_endReset(void);
void Z80_clear(void);
void Z80_upload(const u16 dest, const u8 *data, const u16 size);
void SYS_disableInts(void);
void SYS_enableInts(void);
void waitSubTick(u32 subtick);

/* Used by example/main.c only. */
#define JOY_1        0
#define BUTTON_A     0x0040
#define BUTTON_B     0x0010
#define BUTTON_C     0x0020
#define BUTTON_START 0x0080
u16  JOY_readJoypad(u16 joy);
void VDP_drawText(const char *str, u16 x, u16 y);
void intToHex(u32 value, char *str, u16 minsize);
void SYS_doVBlankProcess(void);
#endif
