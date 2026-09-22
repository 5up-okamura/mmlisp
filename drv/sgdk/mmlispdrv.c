// MMLispDRV — SGDK host implementation. See mmlispdrv.h for the API.
//
// The Z80 image is one of three light engines, one per PCM voice count
// (docs/driver.md §5): each keeps its own fixed DAC clock and consumes
// {op, val} PAIRS from a page in its RAM at fixed slots. A score's MMB header
// names the image; MMLisp_loadScore boots it. This file is what puts the pairs
// there. The sequencer (mmlispseq.c) renders a frame and mmlpairs.c takes it
// from the sequencer's write queue into pairs and PSG bytes (the slot the
// other gates see is never packed here); everything SGDK-specific is here: the
// bring-up, the bus grab, the copy, the PSG port.
//
// ONE GRAB A FRAME, FROM THE VERTICAL INTERRUPT. A grab carries sixteen pairs,
// so the wire is 960 pairs a second — the same as the two-grab host it
// replaces, in half the bus stops, and off the one interrupt every game
// already has. A bus stop is not repaid: the DAC runs slow by the ~45 µs the
// grab held, once a frame (driver.md §5.3).
//
// RENDERED AHEAD, SENT ON TIME. The main loop's MMLisp_frame() renders each
// frame MMLISP_LEAD frames before its time; the pumps send only the frames
// whose time has come, counted from SGDK's vtimer. A render that runs long
// delays nothing that was ready, and the next call catches up — the tempo
// follows the video clock, not the main loop (mmlispdrv.h).
#include "mmlispdrv.h"
#include "mmlispseq.h"
#include "mmlpairs.h"
#include "mmlispdrv_bin.h"   // generated: the images, MMLISPDRV_IMAGES[], the ABI constants

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
// HOW FAR AHEAD THE MAIN LOOP RENDERS, in frames. One absorbs a main loop that
// runs up to a frame late with no audible trace; each frame of lead is a frame
// of latency on the control calls. At most MMLP_FRAMES - 2.
#ifndef MMLISP_LEAD
#define MMLISP_LEAD 1
#endif
// A main loop further behind than this is stopped, not slow (a load, a pause
// screen, a debugger): the music pauses with it instead of playing the missed
// frames in one burst.
#define MMLISP_CATCHUP 3
static u32        frameBase;           // vtimer - frameBase = frames whose time has come
static u16        pauses = 0;
// THE PUMP AND THE PLANNER. MMLisp_frame() (main loop) only fills the queue,
// which mmlpairs.c makes safe against an interrupt-side reader; two pumps must
// never overlap, though — a game may call MMLisp_pump() itself as well as
// letting the interrupt do it. An interrupt runs to completion before the code it
// interrupted resumes, so a plain flag is enough: a pump that finds it set
// returns at once and the next one carries the pairs.
static vu8        busy = FALSE;
static u16        lateGrabs = 0;
// Where a grab's release store goes when the bus was already held by the code
// it interrupted: that code releases it, not us.
static vu16       releaseSink;
static MMLPairsCfg PAIRS_CFG = {
    MMLISPDRV_FIFO, MMLISPDRV_FIFO_PAIRS, MMLISPDRV_PAIRS_PER_GRAB,
    MMLISPDRV_LUT_PAGE, MMLISPDRV_OP_STRIDE, MMLISPDRV_OP_PORT,
    1,   // voices: the booted image's (bootImage)
    1,   // idle_after_gen: likewise
    MMLP_AHEAD_ONE,  // ahead: a whole frame of the engine's reading between grabs
};
static u8         image = 0;           // PCM voices of the booted image, 0 = none yet

// ── Bring-up ───────────────────────────────────────────────────────────────

// Upload and boot the image for `voices` PCM voices (1..3), then wait for its
// ready mark. The order is the one proven on hardware by SGDK's own driver
// loader: take the bus (which also ends reset), fill Z80 RAM while the Z80 is
// stopped but NOT held in reset, then pulse reset with the bus released so it
// boots at 0.
static void writeBankRegister(void);
static void bootImage(u8 voices)
{
    const MMLispDrvImage* img = &MMLISPDRV_IMAGES[voices - 1];
    ready = FALSE;
    image = voices;
    PAIRS_CFG.voices = img->voices;
    PAIRS_CFG.idle_after_gen = img->idleAfterGen;
    mmlp_init(&pairs, &PAIRS_CFG);
    fifoLo = 0xff;

    SYS_disableInts();
    Z80_requestBus(TRUE);
    Z80_clear();
    Z80_upload(0, img->bin, MMLISPDRV_BIN_SIZE);
    // The ready mark cleared, so the poll below cannot see a stale byte.
    *Z80_RAM_AT(MMLISPDRV_READY) = 0;
    Z80_startReset();
    Z80_releaseBus();
    waitSubTick(50);
    Z80_endReset();
    SYS_enableInts();
    if (smpBank) writeBankRegister();

    // Boot is a few milliseconds (the ring and the pair page cleared). Poll the
    // ready mark for up to ~1 s; a sound driver that fails to boot must not
    // freeze the game.
    for (u16 i = 0; i < TICKPERSECOND; i++)
    {
        Z80_requestBus(TRUE);
        u8 mark = *Z80_RAM_AT(MMLISPDRV_READY);
        Z80_releaseBus();
        if (mark == MMLISPDRV_READY_MARK) { ready = TRUE; return; }
        waitSubTick(SUBTICKPERSECOND / TICKPERSECOND);
    }
}

void MMLisp_init(void)
{
    loaded = FALSE;
    rendered = 0;
    // The one-voice image until a score names another: it is the FM/PSG writer
    // for a score without PCM too.
    bootImage(1);
}

bool MMLisp_isReady(void)
{
    return ready;
}

void MMLisp_setSampleBank(const u8* smp)
{
    smpBank = smp;
    writeBankRegister();
    // The sequencer resolves every PCM field itself and needs the bank's
    // directory and its ROM address (driver.md §6.3).
    if (smp && loaded) mml_load_samples(&seq, smp, 0, (u32)smp);
}

static void writeBankRegister(void)
{
    // The Z80 reads the bank through its $8000 window, whose 32 KB bank is the
    // nine-bit register at $A06000 — written one bit at a time, LSB (A15)
    // first, and only with the bus held, since the register is in the Z80's
    // address space. The engine never touches it: the bank is set here, and
    // a parked voice reads the bank's silence page from then on.
    u32 bank = smpBank ? ((u32)smpBank >> 15) : 0;
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
}

bool MMLisp_loadScore(const u8* mmb)
{
    u32 len = mml_mmb_size(mmb, 0);
    if (!len) return FALSE;
    busy = TRUE;                 // no pump while the planner is reset
    loaded = (mml_load(&seq, mmb, len) == 0);
    // THE SCORE NAMES ITS ENGINE IMAGE (MMB header flags, the PCM voice count).
    // Booting another one resets the Z80, which is why it happens here, before
    // anything is primed onto the wire.
    u8 want = (loaded && seq.pcm_voices) ? seq.pcm_voices : 1;
    if (want != image) bootImage(want);
    if (loaded && smpBank) mml_load_samples(&seq, smpBank, 0, (u32)smpBank);
    // PRIMED AT LOAD: the neutral patch the load queues, and every track's
    // leading setup (mml_prime_tracks), leave for the chip over the frames
    // before the game starts the music — ~250 writes for sin008, sixteen
    // frames of the wire that the first notes no longer wait behind. The
    // starts later send only what differs (MMLisp_isSettled says when all of
    // it has gone).
    if (loaded) mml_prime_tracks(&seq);
    mmlp_init(&pairs, &PAIRS_CFG);
    fifoLo = 0xff;
    rendered = 0;
    frameBase = vtimer;          // frame 0's time comes at the next VBlank
    busy = FALSE;
    return loaded;
}

// ── The two hooks ──────────────────────────────────────────────────────────

#define STR_(x) #x
#define STR(x)  STR_(x)
#define GRAB_LATE 0x100

// What one grab writes: the ops of its sixteen pairs, then their values. The
// 68000 is big-endian, so ops[0..3] loaded as a long is ops[0] in the top byte
// — the order movep.l stores them in — and the planner writes the arrays in
// place: nothing is repacked (it was: byte shifts into longs, ~700 cycles a
// pump). Four longs at a time is all the data registers hold, so the ops go
// out, then the values.
typedef struct { u8 ops[16]; u8 vals[16]; u8 prev, dist; } __attribute__((aligned(2))) GrabBlock;

// THE GRAB, in assembly. Written in C over SGDK's Z80_getAndRequestBus() and
// Z80_releaseBus() with a byte loop, it held the bus far longer than this does.
// Everything that can be is computed with the bus free — where the pairs go,
// where the release store goes — and inside it are the request, the grant
// poll, ONE read of the engine's index, the in-grab test (mmlpairs.h
// mmlp_in_time: the index moved by less than `dist`), eight movep.l, and the
// release. MOVEP writes a long to every other byte, which is exactly a pair
// page's layout: ops at even offsets, values at odd ones — so thirty-two bytes
// cost 192 cycles where thirty-two move.b would cost 384. The whole grab is
// about 2,400 master (~45 µs); nothing repays it, so the DAC runs that much
// slow once a frame (driver.md §5).
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
        for (u16 i = 0; i < MMLISPDRV_PAIRS_PER_GRAB; i++)
        {
            d[2 * i]     = blk->ops[i];
            d[2 * i + 1] = blk->vals[i];
        }
    else lo |= GRAB_LATE;
    Z80_releaseBus();
#else
    __asm__ volatile (
        "   movem.l (%[blk]), %%d3-%%d6\n"   // ops[0..15]
        "   moveq   #0, %%d1\n"
        "   move.b  32(%[blk]), %%d1\n"    // prev
        "   moveq   #0, %%d7\n"
        "   move.b  33(%[blk]), %%d7\n"    // dist
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
        "   movep.l %%d3, 0(%[d])\n"     // ops 0-3   -> bytes 0,2,4,6
        "   movep.l %%d4, 8(%[d])\n"     // ops 4-7   -> 8,10,12,14
        "   movep.l %%d5, 16(%[d])\n"    // ops 8-11  -> 16,18,20,22
        "   movep.l %%d6, 24(%[d])\n"    // ops 12-15 -> 24,26,28,30
        "   movem.l 16(%[blk]), %%d3-%%d6\n" // vals[0..15]
        "   movep.l %%d3, 1(%[d])\n"     // vals 0-3  -> 1,3,5,7
        "   movep.l %%d4, 9(%[d])\n"
        "   movep.l %%d5, 17(%[d])\n"
        "   movep.l %%d6, 25(%[d])\n"
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

// One grab, sending the frames before `release` (mmlpairs.h mmlp_plan).
static void pump(u16 release)
{
    if (!ready || busy) return;
    busy = TRUE;
    // Everything that can be decided before the bus is taken is (R20 §48.4):
    // which pairs, where they go, and the registers they are stored from.
    u16 dst = 0;
    static GrabBlock blk;        // static: the planner's arrays, the grab's registers
    blk.prev = fifoLo;
    const u16 n = mmlp_plan(&pairs, fifoLo, release, blk.ops, blk.vals, &dst);
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
    u16 np = mmlp_psg_take(&pairs, release, psg, sizeof psg);
    if (np)
    {
        u16 level = SYS_getAndSetInterruptMaskLevel(7);
        for (u16 i = 0; i < np; i++) MML_PSG_PORT = psg[i];
        SYS_setInterruptMaskLevel(level);
    }
    busy = FALSE;
}

// The frames whose time has come; anything rendered ahead of them waits.
static u16 due(void) { return (u16)(vtimer - frameBase); }

void MMLisp_pump(void)
{
    pump(due());
}

// The frame's grab, from the vertical interrupt. It carries the frame whose
// time has just come, so the music's tempo is the video clock's.
static void vblankPump(void)
{
    pump(due());
}

void MMLisp_attachInterrupts(void)
{
    SYS_setVIntCallback(vblankPump);
}

void MMLisp_frame(void)
{
    if (!ready || !loaded) return;
    // Render until the queue holds MMLISP_LEAD frames past the ones whose time
    // has come. Normally that is one frame a call; after a call that came late
    // it is two or three, and the pumps still send each on its own frame.
    s16 behind = (s16)(u16)(due() + MMLISP_LEAD - rendered);
    if (behind > MMLISP_LEAD + MMLISP_CATCHUP)
    {
        // Stopped, not slow: move the time base so the next frame is due one
        // lead from now, and pause the music for as long as the game stopped.
        const u16 level = SYS_getAndSetInterruptMaskLevel(7);
        frameBase += (u32)(behind - MMLISP_LEAD);
        SYS_setInterruptMaskLevel(level);
        pauses++;
        behind = MMLISP_LEAD;
    }
    while (behind-- > 0)
    {
        // Straight from the sequencer's queue into the pair queue: no slot is
        // packed and parsed again (mmlpairs.h mmlp_render).
        mmlp_render(&pairs, &seq);
        rendered++;
    }
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

u8 MMLisp_trig(u8 track_id)
{
    for (u8 i = 0; i < seq.track_count; i++)
        if (seq.trk[i].track_id == track_id) return seq.trk[i].trig_byte;
    return 0;
}

u8 MMLisp_scoreFrameHz(void)
{
    return loaded ? seq.frame_hz : 0;
}

bool MMLisp_isSettled(void)
{
    // Nothing waiting in the sequencer or for the wire. The last grab's pairs
    // may still be in the engine's page for a few milliseconds.
    return !loaded || (mml_pending(&seq) == 0 && mmlp_pending(&pairs) == 0);
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
    out->faults       = pairs.fault;
    out->image        = image;
    out->fifoLo       = fifoLo;
    out->late         = lateGrabs;
    out->due          = loaded ? due() : 0;
    out->pauses       = pauses;
}
