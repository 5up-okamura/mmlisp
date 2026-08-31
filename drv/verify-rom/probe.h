/* What the ROM publishes and the frontend reads.
 *
 * It lives in 68000 work RAM and the libretro core hands that memory out
 * verbatim (retro_get_memory_data, RETRO_MEMORY_SYSTEM_RAM), so a read costs
 * the emulated machine nothing at all — no debug port, no bus grab, no patched
 * emulator. The build reports this struct's address with `nm`, so nothing here
 * is at a magic number either.
 *
 * Every field is u16 because BlastEm stores work RAM as an array of host-order
 * 16-bit words: a u16 reads back as one word, while a u32 would need the halves
 * put back together by the reader. Two u16s and a comment beat a subtle bug.
 *
 * `volatile` is not decoration. The frontend reads this struct out of RAM while
 * the machine is stopped between frames, so a store the compiler kept in a
 * register — perfectly legal for a global nothing in the program reads back —
 * would simply never be seen.
 */
#ifndef MMLISP_PROBE_H
#define MMLISP_PROBE_H
#include "genesis.h"

#define PROBE_SECS           24      /* one-second windows kept in sec_music[] */

#define PROBE_MAGIC          0x4D4C      /* 'ML' — main() reached, struct valid */

#define PROBE_ST_READY       0x0001      /* the engine answered its ready mark   */
#define PROBE_ST_LOADED      0x0002      /* the MMB parsed                       */
#define PROBE_ST_PCM_MUTE    0x0004      /* score wants samples, none published  */
#define PROBE_ST_INIT_FAILED 0x8000      /* the Z80 never reached its main loop  */
#define PROBE_ST_BAD_MMB     0x4000

/* Written by boot.s from the exception handlers, at the byte offsets below.
 * A run that stops with `stage` short of the loop is either hung or dead, and
 * those have completely different causes — this is what tells them apart. */
#define PROBE_FAULT_NONE     0x0000
#define PROBE_FAULT_EXCEPT   0xDEAD      /* fault_addr = the stacked PC          */
#define PROBE_FAULT_ADDRESS  0xBADD      /* bus/address error: the ACCESS address */

/* boot.s writes through these offsets; the asserts below keep it honest. */
#define PROBE_OFF_FAULT      4
#define PROBE_OFF_FAULT_ADDR 6
#define PROBE_OFF_FAULT_PC   10

typedef struct {
    u16 magic;
    u16 status;
    u16 fault;          /* PROBE_FAULT_* — 0 unless an exception was taken    */
    u16 fault_addr_hi;  /* what the fault was about, split so every field is  */
    u16 fault_addr_lo;  /* one host-order word (see the note above)           */
    u16 fault_pc_hi;    /* where it was, which is what an address gets looked  */
    u16 fault_pc_lo;    /* up against in the disassembly                       */
    u16 stage;          /* last checkpoint reached — see main.c              */
    u16 seconds;        /* one-second windows completed — 0 means no run yet  */
    u16 track_count;
    u16 vblanks;        /* real frames since the tracks started (low 16)      */
    u16 audible;        /* frames the engine CONSUMED in them                 */
    u16 music256;       /* audible/vblanks x256 — 0x100 is dead on            */
    u16 host256;        /* main-loop iterations/vblanks x256                  */
    u16 worst_1s;       /* worst one-second music256                          */
    u16 lost_1s;        /* frames lost in the last second                     */
    u16 starved;        /* cumulative: the ring ran dry                       */
    u16 starv_1s;
    /* music256 for each of the first PROBE_SECS one-second windows. A single
     * average cannot tell a clock that runs steadily fast from one that swings,
     * and "the tempo wobbles" is a statement about the swing. */
    u16 sec_music[PROBE_SECS];
} probe_mailbox;

#define PROBE_WORDS (sizeof(probe_mailbox) / 2)

typedef char probe_off_fault_ok[
    __builtin_offsetof(probe_mailbox, fault) == PROBE_OFF_FAULT ? 1 : -1];
typedef char probe_off_fault_addr_ok[
    __builtin_offsetof(probe_mailbox, fault_addr_hi) == PROBE_OFF_FAULT_ADDR ? 1 : -1];
typedef char probe_off_fault_pc_ok[
    __builtin_offsetof(probe_mailbox, fault_pc_hi) == PROBE_OFF_FAULT_PC ? 1 : -1];

extern volatile probe_mailbox probe;

#endif
