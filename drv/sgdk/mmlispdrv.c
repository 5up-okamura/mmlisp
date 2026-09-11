// MMLispDRV — SGDK host implementation. See mmlispdrv.h for the API.
//
// The Z80 image is the one-voice pair-transport engine (docs/driver.md §5,
// R28 §63): it keeps a fixed 9,987.57 Hz DAC clock and consumes {op, val}
// PAIRS from a page in its RAM, sixteen a lap. This file is what puts them
// there. The sequencer (mmlispseq.c) is unchanged — it still renders a SLOT a
// frame — and mmlpairs.c turns each slot into pairs and PSG bytes; everything
// SGDK-specific is here: the bring-up, the bus grab, the copy, the PSG port.
//
// TWO GRABS A FRAME, BOTH FROM INTERRUPTS. A grab carries at most five pairs
// and may stop the Z80 for at most 1,500 master clocks (what the engine's phase
// corrector repays), so the wire is ~600 pairs a second only if the bus is
// taken twice a frame — and the pairs land ahead of the engine only if the
// grabs are evenly spaced. So they come from the vertical interrupt and a
// horizontal one at line 93, whose spacing the video timing fixes; the main
// loop's MMLisp_frame() only renders into the queue (mmlispdrv.h).
#include "mmlispdrv.h"
#include "mmlispseq.h"
#include "mmlpairs.h"
#include "mmlispdrv_bin.h"   // generated: mmlispdrv_bin[], the ABI constants

// ── Z80 address space, as seen from the 68000 ───────────────────────────────
// Byte accesses only: the Z80 bus is 8-bit, so a word access here duplicates
// the even byte into both halves (R19 §46.3).
#define Z80_RAM_AT(off)   ((vu8*)(0xA00000 + (off)))
#define Z80_BANK_REG      (*(vu8*)0xA06000)
#define MML_PSG_PORT      (*(vu8*)0xC00011)   // SGDK's psg.h names the address PSG_PORT

static MMLSeq     seq;
static MMLPairs   pairs;
static bool       ready  = FALSE;
static bool       loaded = FALSE;
static const u8*  smpBank = NULL;
static u8         fifoLo = 0xff;      // the engine's index as read in the last grab
static u16        rendered = 0;
static u8         slotBuf[MML_SLOT_SIZE];
// THE PUMPS SHARE ONE PLANNER. MMLisp_frame() (main loop) only fills the
// queue, which mmlpairs.c makes safe against an interrupt-side reader; two
// pumps must never overlap, though — the VBlank interrupt can preempt the
// HBlank one, and a game may call MMLisp_pump() itself. An interrupt runs to
// completion before the code it interrupted resumes, so a plain flag is enough:
// a pump that finds it set returns at once and the next one carries the pairs.
static vu8        busy = FALSE;
static vu8        hintArmed = FALSE;   // one HBlank pump a frame (MMLisp_hint)
static u16        lateGrabs = 0;
// Where a grab's release store goes when the bus was already held by the code
// it interrupted: that code releases it, not us.
static vu16       releaseSink;
static const MMLPairsCfg PAIRS_CFG = {
    MMLISPDRV_FIFO, MMLISPDRV_FIFO_PAIRS, MMLISPDRV_PAIRS_PER_GRAB,
    MMLISPDRV_LUT_PAGE, MMLISPDRV_LEVELS, MMLISPDRV_OP_LIMIT,
    MMLISPDRV_OP_IDLE, MMLISPDRV_OP_LEVEL, MMLISPDRV_OP_MASTER,
    MMLISPDRV_OP_SRC_LO, MMLISPDRV_OP_SRC_HI, MMLISPDRV_OP_END_LO, MMLISPDRV_OP_END_HI,
    MMLISPDRV_OP_STEP, MMLISPDRV_OP_START, MMLISPDRV_OP_STOP, MMLISPDRV_OP_PORT,
    0,   // staged_run: mmlp_init works it out
};

// ── Bring-up ───────────────────────────────────────────────────────────────

void MMLisp_init(void)
{
    ready  = FALSE;
    loaded = FALSE;
    fifoLo = 0xff;
    rendered = 0;
    mmlp_init(&pairs, &PAIRS_CFG);

    // The order proven on hardware by SGDK's own driver loader: take the bus
    // (which also ends reset), fill Z80 RAM while the Z80 is stopped but NOT
    // held in reset, then pulse reset with the bus released so it boots at 0.
    SYS_disableInts();
    Z80_requestBus(TRUE);
    Z80_clear();
    Z80_upload(0, mmlispdrv_bin, MMLISPDRV_BIN_SIZE);
    // The runtime protocol's control block, read by the engine's boot: this is
    // run 0 of phase stretch 0 with nothing committed. And the ready mark
    // cleared, so the poll below cannot be satisfied by a stale byte.
    *Z80_RAM_AT(MMLISPDRV_CTL_BOOT_GEN)       = 0;
    *Z80_RAM_AT(MMLISPDRV_CTL_BOOT_GEN + 1)   = 0;
    *Z80_RAM_AT(MMLISPDRV_CTL_PHASE_GEN)      = 0;
    *Z80_RAM_AT(MMLISPDRV_CTL_COMMAND_COMMIT) = 0;
    *Z80_RAM_AT(MMLISPDRV_CTL_PHASE_COMMIT)   = 0;
    *Z80_RAM_AT(MMLISPDRV_READY)              = 0;
    Z80_startReset();
    Z80_releaseBus();
    waitSubTick(50);
    Z80_endReset();
    SYS_enableInts();

    // Boot is a few milliseconds (the level family is copied into place, the
    // pair page cleared). Poll the ready mark for up to ~1 s; a sound driver
    // that fails to boot must not freeze the game.
    for (u16 i = 0; i < TICKPERSECOND; i++)
    {
        Z80_requestBus(TRUE);
        u8 mark = *Z80_RAM_AT(MMLISPDRV_READY);
        Z80_releaseBus();
        if (mark == MMLISPDRV_READY_MARK) { ready = TRUE; return; }
        waitSubTick(SUBTICKPERSECOND / TICKPERSECOND);
    }
}

bool MMLisp_isReady(void)
{
    return ready;
}

void MMLisp_setSampleBank(const u8* smp)
{
    // The Z80 reads the bank through its $8000 window, whose 32 KB bank is the
    // nine-bit register at $A06000 — written one bit at a time, LSB (A15)
    // first, and only with the bus held, since the register is in the Z80's
    // address space. The engine never touches it: the bank is set here, once,
    // and the parked voice reads the bank's silence page from then on.
    smpBank = smp;
    u32 bank = smp ? ((u32)smp >> 15) : 0;
    u8 bits[10];
    for (u8 i = 0; i < 9; i++) bits[i] = (u8)((bank >> i) & 1);
    // Nine stores in a grab of their own, written like the pump's: the engine
    // is running, and SGDK's Z80_requestBus() path held the bus 3,500 master
    // for these nine bytes (1,660 in plain C).
    busy = TRUE;
#ifndef __m68k__
    Z80_requestBus(TRUE);
    for (u8 i = 0; i < 9; i++) Z80_BANK_REG = bits[i];
    Z80_releaseBus();
#else
    const u8* b = bits;
    __asm__ volatile (
        "   lea     0xA06000, %%a1\n"
        "   lea     0xA11100, %%a3\n"
        "   move.w  #0x0100, (%%a3)\n"
        "1: btst    #0, (%%a3)\n"
        "   bne.s   1b\n"
        "   .rept   9\n"
        "   move.b  (%[b])+, (%%a1)\n"
        "   .endr\n"
        "   move.w  #0x0000, (%%a3)\n"
        : [b] "+a" (b)
        :
        : "a1", "a3", "cc", "memory");
#endif
    busy = FALSE;
    // The sequencer resolves every PCM field itself and needs the bank's
    // directory and its ROM address (driver.md §6.3).
    if (smp && loaded) mml_load_samples(&seq, smp, 0, (u32)smp);
}

bool MMLisp_loadScore(const u8* mmb)
{
    u32 len = mml_mmb_size(mmb, 0);
    if (!len) return FALSE;
    busy = TRUE;                 // no pump while the planner is reset
    loaded = (mml_load(&seq, mmb, len) == 0);
    if (loaded && smpBank) mml_load_samples(&seq, smpBank, 0, (u32)smpBank);
    mmlp_init(&pairs, &PAIRS_CFG);
    fifoLo = 0xff;
    busy = FALSE;
    return loaded;
}

// ── The two hooks ──────────────────────────────────────────────────────────

#define STR_(x) #x
#define STR(x)  STR_(x)
#define GRAB_LATE 0x100

// What one grab writes, loaded into four data registers before the bus is
// taken: the ops of pairs 0-7, then their values. The 68000 is big-endian, so
// ops[0..3] loaded as a long is ops[0] in the top byte — the order movep.l
// stores them in — and the planner writes the arrays in place: nothing is
// repacked (it was: sixteen byte shifts into four longs, ~700 cycles a pump).
typedef struct { u8 ops[8]; u8 vals[8]; u8 prev, dist; } __attribute__((aligned(2))) GrabBlock;

// THE GRAB, in assembly. Written in C over SGDK's Z80_getAndRequestBus() and
// Z80_releaseBus() with a byte loop, it held the bus ~2,800 master on BlastEm
// against the engine's 1,500. Everything is computed with the bus free — the
// eight pairs in registers, where the release store goes — and inside it are
// the request, the grant poll, ONE read of the engine's index, the in-grab
// test (mmlpairs.h mmlp_in_time: the index moved by less than `dist`), four
// movep.l, and the release. MOVEP writes a long to every other byte, which is
// exactly a pair page's layout: ops at even offsets, values at odd ones — so
// sixteen bytes cost 96 cycles where sixteen move.b would cost 192.
//
// The Z80 is on a byte-wide bus; movep's accesses are single bytes (UDS for
// the even run, LDS for the odd), which is what the Z80 window takes.
//
// Returns the index byte; GRAB_LATE set when the engine was already at or
// past the destination and nothing was written.
static u16 grab(const GrabBlock* blk, u16 dst)
{
    u16 lo;
    vu8* d = Z80_RAM_AT(dst);
    vu16* sink = &releaseSink;
#ifndef __m68k__
    // What the assembly below does, for the host-side type-check
    // (tools/sgdk-lint.mjs) — never built for the machine.
    (void)sink;
    Z80_requestBus(TRUE);
    lo = *Z80_RAM_AT(MMLISPDRV_FIFO_LO);
    if ((u8)(lo - blk->prev) < blk->dist)
        for (u16 i = 0; i < 8; i++)
        {
            d[2 * i]     = blk->ops[i];
            d[2 * i + 1] = blk->vals[i];
        }
    else lo |= GRAB_LATE;
    Z80_releaseBus();
#else
    __asm__ volatile (
        "   movem.l (%[blk]), %%d3-%%d6\n"
        "   moveq   #0, %%d1\n"
        "   move.b  16(%[blk]), %%d1\n"    // prev
        "   moveq   #0, %%d7\n"
        "   move.b  17(%[blk]), %%d7\n"    // dist
        "   lea     0xA11100, %%a3\n"
        "   move.l  %%a3, %%a4\n"
        "   moveq   #0, %[lo]\n"
        "   btst    #0, (%%a3)\n"          // BUSACK low: someone already holds the bus
        "   bne.s   0f\n"
        "   move.l  %[sink], %%a4\n"       // …so our release must not free it
        "0: move.w  #0x0100, (%%a3)\n"     // request
        "1: btst    #0, (%%a3)\n"
        "   bne.s   1b\n"
        "   move.b  0xA00000+" STR(MMLISPDRV_FIFO_LO) ", %[lo]\n"
        "   move.b  %[lo], %%d2\n"
        "   sub.b   %%d1, %%d2\n"
        "   cmp.b   %%d7, %%d2\n"
        "   bcc.s   8f\n"                  // late: write nothing
        "   movep.l %%d3, 0(%[d])\n"
        "   movep.l %%d5, 1(%[d])\n"
        "   movep.l %%d4, 8(%[d])\n"
        "   movep.l %%d6, 9(%[d])\n"
        "9: move.w  #0x0000, (%%a4)\n"     // release (or the sink)
        "   bra.s   7f\n"
        "8: ori.w   #0x100, %[lo]\n"
        "   bra.s   9b\n"
        "7:\n"
        : [lo] "=&d" (lo)
        : [blk] "a" (blk), [d] "a" (d), [sink] "g" (sink)
        : "d1", "d2", "d3", "d4", "d5", "d6", "d7", "a3", "a4", "cc", "memory");
#endif
    return lo;
}

void MMLisp_pump(void)
{
    if (!ready || busy) return;
    busy = TRUE;
    // Everything that can be decided before the bus is taken is (R20 §48.4):
    // which pairs, where they go, and the registers they are stored from.
    u16 dst = 0;
    static GrabBlock blk;        // static: the planner's arrays, the grab's registers
    blk.prev = fifoLo;
    const u16 n = mmlp_plan(&pairs, fifoLo, blk.ops, blk.vals, &dst);
    // Nothing planned: the grab only reads the index (dist 0 is always late).
    blk.dist = n ? (u8)((u8)dst - fifoLo) : 0;
    const u16 got = grab(&blk, dst);
    fifoLo = (u8)got;
    // A late grab gives its pairs back; everything written before them has
    // been consumed, so the next plan starts from the index just read.
    if (n && (got & GRAB_LATE)) { mmlp_abort(&pairs); lateGrabs++; }

    // The PSG is in the VDP's address space: no bus grab. Its bytes are the
    // ones queued before the PREVIOUS pump, so they land about when the FM
    // writes they were cued with come out of the pair page. A tone period is
    // two bytes and the chip applies the first on its own, so the run is
    // written with interrupts masked — by level, not SYS_disableInts(), which
    // keeps a nesting count an interrupt-side caller must not touch.
    u8  psg[MMLP_PSG];
    u16 np = mmlp_psg_take(&pairs, psg, sizeof psg);
    if (np)
    {
        u16 level = SYS_getAndSetInterruptMaskLevel(7);
        for (u16 i = 0; i < np; i++) MML_PSG_PORT = psg[i];
        SYS_setInterruptMaskLevel(level);
    }
    busy = FALSE;
}

// SGDK's horizontal interrupt vector JUMPS to the callback — no wrapper saves
// registers or returns with RTE for it — so the callback has to be an
// interrupt function itself. A plain C function there returns with RTS into
// whatever the stack holds.
HINTERRUPT_CALLBACK MMLisp_hint(void)
{
    // The counter fires again 94 lines later, still inside the picture; the
    // VBlank pump re-arms this one, so only the first of them grabs.
    if (!hintArmed) return;
    hintArmed = FALSE;
    MMLisp_pump();
}

static void vblankPump(void)
{
    hintArmed = TRUE;
    MMLisp_pump();
}

void MMLisp_attachInterrupts(void)
{
    // WHERE THE HBLANK PUMP GOES. The engine's phase corrector repays 1,500
    // master of bus stop per 80 samples (8.0 ms, ~126 lines); two pumps closer
    // than that can land in one observation and add up. Line 93 puts the pump
    // 131 lines from the VBlank one both ways on NTSC (8.34 ms each), and 182
    // and 131 on PAL. At line 112 the two were 7.1 ms apart and did share one.
    hintArmed = FALSE;
    SYS_setVIntCallback(vblankPump);
    VDP_setHIntCounter(93);
    SYS_setHIntCallback(MMLisp_hint);
    VDP_setHInterrupt(TRUE);
}

void MMLisp_frame(void)
{
    if (!ready || !loaded) return;
    // One frame, rendered now: the sequencer runs exactly once a frame and its
    // output waits in the pair queue for the two interrupt-side grabs.
    u32 len = mml_render_frame(&seq, slotBuf);
    mmlp_slot(&pairs, slotBuf, (u16)len);
    rendered++;
}

// ── Track control ──────────────────────────────────────────────────────────
// These run IN the sequencer, so they are plain calls with no transport at all.

void MMLisp_startTrack(u8 track_id)  { if (loaded) mml_start_track(&seq, track_id); }
void MMLisp_stopTrack(u8 track_id)   { if (loaded) mml_stop_track(&seq, track_id); }
void MMLisp_keyOff(u8 channel_id)    { if (loaded) mml_key_off(&seq, channel_id); }

void MMLisp_setParam(u8 channel_id, u8 target_id, s8 value)
{
    if (loaded) mml_set_param(&seq, channel_id, target_id, value);
}

void MMLisp_fadeTrack(u8 track_id, u16 frames)
{
    if (loaded) mml_fade_track(&seq, track_id, frames);
}

void MMLisp_setVal(u8 slot, s16 value)
{
    mml_set_val(&seq, slot, value);
}

s16 MMLisp_getVal(u8 slot)
{
    return (slot < 16) ? seq.val[slot] : 0;
}

// ── Status ─────────────────────────────────────────────────────────────────

u8 MMLisp_trackCount(void)        { return loaded ? mml_track_count(&seq) : 0; }
u8 MMLisp_trackId(u8 index)       { return loaded ? mml_track_id(&seq, index) : 0; }

bool MMLisp_needsSampleBank(void)
{
    return loaded && mml_needs_samples(&seq);
}

bool MMLisp_trackActive(u8 track_id)
{
    for (u8 i = 0; i < seq.track_count; i++)
        if (seq.trk[i].track_id == track_id) return seq.trk[i].running != 0;
    return FALSE;
}

u16 MMLisp_renderedFrames(void)
{
    return rendered;
}

void MMLisp_readStats(MMLispStats* out)
{
    // Nothing here touches the Z80: every number is the host's own.
    out->rendered     = rendered;
    out->pending      = mmlp_pending(&pairs);
    out->grabs        = pairs.grabs;
    out->pairsWritten = pairs.pairs_written;
    out->overflow     = pairs.overflow;
    out->dropped      = (u16)(pairs.dropped_voice + pairs.dropped_loop);
    out->stepRounded  = pairs.step_rounded;
    out->fifoLo       = fifoLo;
    out->late         = lateGrabs;
}
