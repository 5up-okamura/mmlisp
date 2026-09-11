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
bool Z80_getAndRequestBus(bool wait);
void Z80_releaseBus(void);
void Z80_startReset(void);
void Z80_endReset(void);
void Z80_clear(void);
void Z80_upload(const u16 dest, const u8 *data, const u16 size);
void SYS_disableInts(void);
void SYS_enableInts(void);
u16  SYS_getAndSetInterruptMaskLevel(u16 value);
void SYS_setInterruptMaskLevel(u16 value);
void waitSubTick(u32 subtick);
/* SGDK 2.x: the HInt vector JUMPS to the callback, so it must be an interrupt
 * function (all registers saved, RTE). The host compiler has no m68k interrupt
 * attribute; the lint only needs the declaration to parse. */
#define HINTERRUPT_CALLBACK void

/* Used by example/main.c only. */
/* SGDK increments this from its own vertical interrupt handler, so it counts
 * REAL frames whether or not the main loop kept up — which is the only clock
 * the music's speed can honestly be measured against.
 *
 * VOLATILE, and it has to be: the value changes in an interrupt, so a loop that
 * waits on it is an infinite loop the moment the compiler decides one load will
 * do. That is exactly what happened to verify-rom's frame wait at -Os. */
extern vu32 vtimer;
#define JOY_1        0
#define BUTTON_A     0x0040
#define BUTTON_B     0x0010
#define BUTTON_C     0x0020
#define BUTTON_START 0x0080
u16  JOY_readJoypad(u16 joy);
void VDP_drawText(const char *str, u16 x, u16 y);
void intToHex(u32 value, char *str, u16 minsize);
void SYS_doVBlankProcess(void);
/* The two hooks the pair transport needs (mmlispdrv.h): a callback a frame and
 * one mid-frame from the horizontal interrupt. */
typedef void VoidCallback(void);
void SYS_setVIntCallback(VoidCallback *CB);
void SYS_setHIntCallback(VoidCallback *CB);
void VDP_setHIntCounter(u8 value);
void VDP_setHInterrupt(u8 value);
/* The autoplay build turns the pads off (SGDK halts the Z80 to read them). */
#define PORT_1           0x0000
#define PORT_2           0x0001
#define JOY_SUPPORT_OFF  0x00
void JOY_setSupport(u16 port, u16 support);
#endif
