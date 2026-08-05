// MMLispDRV — SGDK host implementation. See mmlispdrv.h for the API and the
// verification-status caveat.
//
// Post-split this file is thin on purpose. The sequencer is mmlispseq.c, which
// is portable C with no SGDK dependency — that is what lets the host gate run
// it natively (driver.md §12.2). Everything SGDK-specific lives here: the Z80
// bring-up, the bus grab, and the copy of a rendered slot into Z80 RAM.
#include "mmlispdrv.h"
#include "mmlispseq.h"
#include "mmlispdrv_bin.h"   // generated: mmlispdrv_bin[], the header constants

// ── Z80 address space, as seen from the 68000 (Z80 RAM is at 0xA00000) ──────
// Byte accesses only: the Z80 bus is 8-bit, so a word access here is undefined.
#define Z80_RAM_AT(off)   ((vu8*)(0xA00000 + (off)))

// The published header (driver.md §6.4). Its address is the ONE Z80 constant
// compiled in here; the ring's depth, slot stride and base address are read out
// of the header at boot, so the engine is their single owner and a rebuild of
// it cannot silently disagree with this file.
#define H_HEAD     (MMLISPDRV_HDR + 0)   // 68k-owned: next slot to fill
#define H_TAIL     (MMLISPDRV_HDR + 1)   // Z80-owned: next slot to consume
#define H_FRAMES   (MMLISPDRV_HDR + 2)   // u16 Z80-owned: frames CONSUMED
#define H_READY    (MMLISPDRV_HDR + 4)
#define H_VER      (MMLISPDRV_HDR + 5)
#define H_SMPBANK  (MMLISPDRV_HDR + 6)   // u16 68k-owned: PCM sample ROM bank
#define H_DEPTH    (MMLISPDRV_HDR + 8)
#define H_SLOTSH   (MMLISPDRV_HDR + 9)
#define H_RING     (MMLISPDRV_HDR + 10)  // u16 ring base in Z80 RAM
#define H_STARVE   (MMLISPDRV_HDR + 12)  // u16 Z80-owned: starved frames

static MMLSeq     seq;
static bool       ready     = FALSE;
static bool       loaded    = FALSE;
static u8         ringDepth = 0;
static u8         slotShift = 0;
static u16        ringBase  = 0;
static u8         ringHead  = 0;   // ours: the engine never writes it
// Remembered so loading a score cannot silently drop the sample bank: mml_load
// clears the whole sequencer, table included, and "every PCM note vanished"
// is a failure that looks exactly like a missing track.
static const u8*  smpBank   = NULL;

// ── Bring-up ───────────────────────────────────────────────────────────────

void MMLisp_init(void)
{
    // Bring-up order mirrors SGDK's own Z80_loadDriverInternal, which is the
    // sequence proven on hardware: take the bus (Z80_requestBus also *ends*
    // reset), fill Z80 RAM while the Z80 is stopped but NOT held in reset, then
    // pulse reset with the bus released so the Z80 restarts at PC=0. Loading
    // while reset is asserted is the one order to avoid.
    ready    = FALSE;
    loaded   = FALSE;
    ringHead = 0;      // the engine zeroes head/tail at boot

    SYS_disableInts();
    Z80_requestBus(TRUE);
    Z80_clear();
    Z80_upload(0, mmlispdrv_bin, MMLISPDRV_BIN_SIZE);
    Z80_startReset();
    Z80_releaseBus();
    waitSubTick(50);    // hold reset long enough for the Z80 to see it (SGDK's timing)
    Z80_endReset();     // → boots at PC=0
    SYS_enableInts();

    // Bounded wait: the engine reports ready within a frame or two, and a sound
    // driver that fails to boot must not freeze the game. Poll ~1 s, then give
    // up — the caller can ask MMLisp_isReady() what happened.
    for (u16 i = 0; i < TICKPERSECOND; i++)
    {
        Z80_requestBus(TRUE);
        u8 mark = *Z80_RAM_AT(H_READY);
        u8 ver  = *Z80_RAM_AT(H_VER);
        if (mark == MMLISPDRV_READY_MARK)
        {
            // Read the ring's geometry from the engine rather than assuming it.
            // A depth mismatch between the two sides fails SILENTLY — the 68k
            // stalls thinking the ring is full, or writes a slot that does not
            // exist — so neither side gets to guess.
            ringDepth = *Z80_RAM_AT(H_DEPTH);
            slotShift = *Z80_RAM_AT(H_SLOTSH);
            ringBase  = (u16)(*Z80_RAM_AT(H_RING) | (*Z80_RAM_AT(H_RING + 1) << 8));
            Z80_releaseBus();
            // A protocol bump means this file and the image were built from
            // different revisions; refuse rather than write garbage into RAM
            // whose layout moved.
            ready = (ver == MMLISPDRV_PROTO_VER) && (ringDepth >= 2);
            return;
        }
        Z80_releaseBus();
        waitSubTick(SUBTICKPERSECOND / TICKPERSECOND);
    }
}

bool MMLisp_isReady(void)
{
    return ready;
}

void MMLisp_setSampleBank(const u8* smp)
{
    // PCM blobs ride their own 32 KB-aligned ROM bank (song.smp). The bank the
    // mixer actually latches travels inside each PCM_START (driver.md §6.3) —
    // this header field is the protocol's reserved slot for it, kept current so
    // a debugger sees the same value the sequencer is resolving against.
    //
    // Call AFTER MMLisp_init — init's Z80_clear wipes Z80 RAM. Order against
    // MMLisp_loadScore does not matter: the pointer is remembered and re-applied
    // on every load. 0 means "no sample bank": every PCM note is then dropped
    // and the DAC is never even enabled.
    smpBank = smp;
    u16 bank = smp ? (u16)((u32)smp >> 15) : 0;
    Z80_requestBus(TRUE);
    *Z80_RAM_AT(H_SMPBANK)     = bank & 0xFF;
    *Z80_RAM_AT(H_SMPBANK + 1) = (bank >> 8) & 0xFF;
    Z80_releaseBus();

    // The sequencer resolves every PCM field itself (driver.md §6.3), so it
    // needs two things: the bank's entry table — the 20-byte-per-sample
    // directory that precedes the blobs, read straight out of ROM — and the
    // bank's ADDRESS, because PCM_START carries an absolute {bank, window
    // offset} and nothing but the host knows where rescomp linked the blob.
    // The blob itself is the Z80's business alone.
    if (smp && loaded) mml_load_samples(&seq, smp, 0, (u32)smp);
}

bool MMLisp_loadScore(const u8* mmb)
{
    // The MMB is 68k memory now: no window, no bank, no alignment. Its own
    // section table says how long it is, since rescomp hands over a bare
    // pointer.
    u32 len = mml_mmb_size(mmb, 0);
    if (!len) return FALSE;
    loaded = (mml_load(&seq, mmb, len) == 0);
    if (loaded && smpBank) mml_load_samples(&seq, smpBank, 0, (u32)smpBank);
    return loaded;
}

// ── The per-frame hook ─────────────────────────────────────────────────────

// Copy one rendered slot into its ring cell.
//
// The grab is taken HERE, per slot, rather than once around the whole call —
// because a grab halts the Z80, and the render between two slots is the
// sequencer's entire frame of work. Holding the bus across that would stop the
// mixer for milliseconds: an audible dropout, not the tens of microseconds §1.3
// budgets for jitter. What §6.6 rules out is a grab per WRITE; this is a grab
// per 256-byte copy, which is the transfer itself.
static void slot_to_z80(void* ctx, u8 index, const u8* bytes, u16 len)
{
    (void)ctx;
    Z80_requestBus(TRUE);
    vu8* dst = Z80_RAM_AT(ringBase + ((u16)index << slotShift));
    for (u16 i = 0; i < len; i++) dst[i] = bytes[i];
    Z80_releaseBus();
}

void MMLisp_frame(void)
{
    if (!ready || !loaded) return;

    // `tail` is the engine's; `head` is ours, so we keep it rather than read it
    // back. A stale tail is safe by construction — tail only ever advances,
    // which only ever frees space, so reading it early makes this call render
    // conservatively and never over-fill.
    Z80_requestBus(TRUE);
    u8 tail = *Z80_RAM_AT(H_TAIL);
    Z80_releaseBus();

    u8 next = mml_pump(&seq, ringHead, tail, ringDepth, slot_to_z80, NULL);
    if (next == ringHead) return;   // ring full: nothing rendered, nothing to say

    // head LAST, after every byte is in place — the ring discipline the engine
    // consumes against (§6.1).
    Z80_requestBus(TRUE);
    *Z80_RAM_AT(H_HEAD) = next;
    Z80_releaseBus();
    ringHead = next;
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
    // The score reads the slot via PARAM_FROM_VAL / _ADD_VAL / _MUL_VAL at
    // dispatch time (driver.md §6.4). Interactive control: a filter-depth
    // slider, game-state-driven timbre, live tempo.
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

u16 MMLisp_starvedFrames(void)
{
    Z80_requestBus(TRUE);
    u16 n = (u16)(*Z80_RAM_AT(H_STARVE) | (*Z80_RAM_AT(H_STARVE + 1) << 8));
    Z80_releaseBus();
    return n;
}

u16 MMLisp_audibleFrame(void)
{
    Z80_requestBus(TRUE);
    u16 f = (u16)(*Z80_RAM_AT(H_FRAMES) | (*Z80_RAM_AT(H_FRAMES + 1) << 8));
    Z80_releaseBus();
    return f;
}

// One grab for all three. The Z80 is stopped for the duration of a grab, so
// four separate calls a frame perturb exactly what they are trying to measure —
// this exists so the diagnostic does not have to be its own worst source of
// error (driver.md §6.4).
void MMLisp_readStats(MMLispStats* out)
{
    Z80_requestBus(TRUE);
    out->audible = (u16)(*Z80_RAM_AT(H_FRAMES) | (*Z80_RAM_AT(H_FRAMES + 1) << 8));
    out->starved = (u16)(*Z80_RAM_AT(H_STARVE) | (*Z80_RAM_AT(H_STARVE + 1) << 8));
    Z80_releaseBus();
}
