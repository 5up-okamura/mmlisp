// Minimal SGDK program that plays an MMLisp score through MMLispDRV.
//
// Build layout (see drv/sgdk/README.md):
//   src/main.c            this file
//   src/mmlispdrv.c       the host glue      \
//   src/mmlispseq.c       the sequencer       ) copied by
//   src/mmlispseq_tables.c its constant tables ) drv/tools/install-sgdk.mjs
//   src/mmlpairs.c        the slot -> pair converter
//   inc/mmlispdrv.h  inc/mmlispseq.h  inc/mmlpairs.h  inc/mmlispdrv_bin.h (generated)
//   inc/mml_rate.h        the sample clock — mmlispseq.h includes it
//   res/song.res          the BIN resources: song.mmb, and song.smp for a PCM score
//
// Controls: A / START = play, B = stop, C = show state.
#include <genesis.h>
#include "mmlispdrv.h"
#include "song.h"        // rescomp: `song_mmb` (and `song_smp` for a PCM score)

// ── PCM scores ──────────────────────────────────────────────────────────────
// A score with `def :sample` ships res/song.smp beside res/song.mmb, and needs
// BOTH of these or not one PCM note plays:
//
//   1. uncomment the `BIN song_smp "song.smp" 32768` line in res/song.res
//   2. set MMLISP_PCM_SAMPLES to 1 below
//
// It is conditional because `song_smp` is not a symbol until step 1 is done, so
// a non-PCM project would fail to link. Deliberately a 0/1 value rather than a
// commented-out #define: a `// #define …` on the last line of a comment block is
// exactly what a formatter reflows into the prose above it, which is how this
// switch got lost once already. A real preprocessor line survives that.
#ifndef MMLISP_PCM_SAMPLES          // (or pass -DMMLISP_PCM_SAMPLES=1)
#define MMLISP_PCM_SAMPLES 0
#endif

// Start every track on boot, without waiting for a button — what the machine
// gate builds (drv/tools/sgdk-gate.mjs) so a headless run has music to grade.
#ifndef MMLISP_AUTOPLAY
#define MMLISP_AUTOPLAY 0
#endif

// A stand-in for a game's own work, for the machine gate (sgdk-gate --burn N):
// N iterations of a busy loop every frame, and twice that every 64th frame —
// long enough to push the main loop past a frame. 0 in a real program.
#ifndef MMLISP_BURN
#define MMLISP_BURN 0
#endif

// One pump a frame from VBlank, leaving HBlank to the game (sgdk-gate
// --vblank-only builds it).
#ifndef MMLISP_VBLANK_ONLY
#define MMLISP_VBLANK_ONLY 0
#endif

#define MAX_SHOWN_TRACKS 10

static void drawHex(u32 value, u16 digits, u16 x, u16 y)
{
    char hex[16];   // intToHex writes up to 8 digits + NUL
    intToHex(value, hex, digits);
    VDP_drawText(hex, x, y);
}

static void playAll(void)
{
    // Every track in one frame. Each track's clock starts on the frame it was
    // set up in, so spreading the starts would leave them permanently out of
    // phase — and the setup frame is silent anyway (driver.md §4.2).
    for (u8 i = 0; i < MMLisp_trackCount(); i++)
        MMLisp_startTrack(MMLisp_trackId(i));
}

int main(bool hardReset)
{
    // Upload and boot the Z80 engine: the one-voice pair-transport engine,
    // ~7 KB with its level tables (docs/dac-engine-implementation.md R28 §63).
    MMLisp_init();

    // NOT READY means the engine never reached its main loop, so the fault is in
    // the upload/reset path, not in the score (README "Confirming it works").
    if (!MMLisp_isReady())
    {
        VDP_drawText("MMLispDRV NOT READY", 2, 2);
        while (TRUE) SYS_doVBlankProcess();
    }

#if MMLISP_PCM_SAMPLES
    MMLisp_setSampleBank(song_smp);
#endif

    if (!MMLisp_loadScore(song_mmb))
    {
        VDP_drawText("BAD MMB", 2, 2);
        while (TRUE) SYS_doVBlankProcess();
    }

    // THE TWO PUMPS (mmlispdrv.h): the VBlank callback and an HBlank one at
    // line 93 carry the pairs to the Z80; MMLisp_frame() below only renders.
    // A game with its own VBlank/HBlank callbacks calls MMLisp_pump() from
    // them instead. A game that needs the horizontal interrupt for itself
    // builds with MMLISP_VBLANK_ONLY=1: one pump a frame, half the wire.
#if MMLISP_VBLANK_ONLY
    MMLisp_attachVBlankOnly();
#else
    MMLisp_attachInterrupts();
#endif

#if MMLISP_AUTOPLAY
    // The headless gate (drv/tools/sgdk-gate.mjs) grades the driver's own bus
    // stops; SGDK's joypad reads halt the Z80 too (HALT_Z80_ON_IO), so the
    // autoplay build reads no pads.
    JOY_setSupport(PORT_1, JOY_SUPPORT_OFF);
    JOY_setSupport(PORT_2, JOY_SUPPORT_OFF);
#endif

    // The score plays PCM and no sample bank was published: every PCM note is
    // dropped. Warn, but play — running a score without its PCM is a useful
    // thing to be able to do on purpose.
    const bool noSamples = MMLisp_needsSampleBank();

    VDP_drawText(noSamples ? "READY (NO SAMPLE BANK: PCM MUTE)" : "MMLispDRV ready", 2, 2);
    VDP_drawText("A/START play  B stop  C stat", 2, 3);
    VDP_drawText("pad:", 2, 5);
    // ── The readout ─────────────────────────────────────────────────────────
    // `host x256` is this loop's own health: iterations per real frame against
    // SGDK's `vtimer`, which is incremented from the vertical interrupt and so
    // keeps counting when THIS loop misses a frame. 0x100 is one iteration a
    // frame; below it the 68000 side is late and nothing the driver reports
    // means anything yet.
    //
    // `pend` is the pairs waiting for the wire. A handful is steady state; a
    // number that keeps climbing means the score asks for more register writes
    // a second than two grabs a frame carry (~600), or the interrupt pumps are
    // not running. `ovf` is pairs LOST to a full queue — it must stay 0.
    // `late` is grabs that came too late to write and left it to the next.
    // `drop` is PCM commands this one-voice profile cannot play (pcm2/pcm3,
    // loops); `grabs` should advance by ~120 a second.
    VDP_drawText("host x256:", 2, 7);
    VDP_drawText("frames:", 19, 7);
    VDP_drawText("pend:", 2, 8);
    VDP_drawText("ovf:", 12, 8);
    VDP_drawText("flt:", 22, 8);
    VDP_drawText("grabs:", 2, 9);
    VDP_drawText("pairs:", 14, 9);
    VDP_drawText("fifo:", 28, 9);
    VDP_drawText("late:", 2, 10);
    VDP_drawText("track active:", 2, 12);

    u16 prev = 0;
    u16 loops = 0;
    u32 baseTimer = vtimer;
    u32 markTimer = vtimer;
    MMLispStats st;

#if MMLISP_AUTOPLAY
    // The load primed the score (mmlispdrv.h): let its writes reach the chip
    // before the music starts, so the first notes do not wait behind them.
    for (u16 i = 0; i < 60 && !MMLisp_isSettled(); i++)
    {
        MMLisp_frame();
        SYS_doVBlankProcess();
    }
    playAll();
    VDP_drawText("PLAY", 2, 17);
#endif

    while (TRUE)
    {
        u16 joy = JOY_readJoypad(JOY_1);
        u16 pressed = joy & ~prev;      // edge, not level

        // Input feedback, drawn only when the pad changes — without it there is
        // no way to tell "the press never arrived" from "the driver ignored it".
        if (joy != prev) drawHex(joy, 4, 7, 5);
        prev = joy;

        if (pressed & (BUTTON_A | BUTTON_START))
        {
            baseTimer = vtimer;
            loops = 0;
            playAll();
            VDP_drawText("PLAY", 2, 17);
        }

        if (pressed & BUTTON_B)
        {
            for (u8 i = 0; i < MMLisp_trackCount(); i++)
                MMLisp_stopTrack(MMLisp_trackId(i));
            VDP_drawText("STOP", 2, 17);
        }

        // The readout costs no bus grab — every number is the host's own — so
        // once a second is a choice of legibility, not of interference.
        if ((u16)(vtimer - markTimer) >= 60)
        {
            MMLisp_readStats(&st);
            const u32 elapsed = vtimer - baseTimer;
            drawHex(elapsed ? ((u32)loops << 8) / elapsed : 0, 4, 13, 7);
            drawHex(st.rendered, 4, 27, 7);
            drawHex(st.pending, 4, 7, 8);
            drawHex(st.overflow, 4, 16, 8);
            drawHex(st.faults, 4, 27, 8);
            drawHex(st.grabs, 4, 8, 9);
            drawHex(st.pairsWritten, 4, 20, 9);
            drawHex(st.fifoLo, 2, 33, 9);
            drawHex(st.late, 4, 8, 10);
            markTimer = vtimer;
        }

        if (pressed & BUTTON_C)
        {
            u8 n = MMLisp_trackCount();
            if (n > MAX_SHOWN_TRACKS) n = MAX_SHOWN_TRACKS;
            for (u8 i = 0; i < n; i++)
                drawHex(MMLisp_trackActive(MMLisp_trackId(i)) ? 1 : 0, 1, 17 + i, 12);
        }

#if MMLISP_BURN
        {
            static u16 frameNo;
            volatile u16 sink = 0;
            u16 n = ((++frameNo & 63) == 0) ? 2 * MMLISP_BURN : MMLISP_BURN;
            while (n--) sink++;
        }
#endif

        // ── Once a frame, and last ───────────────────────────────────────────
        // Control calls above take effect on the frame this renders, so putting
        // it after them costs no extra latency. It renders exactly one frame
        // into the queue; the interrupts carry it.
        MMLisp_frame();

        SYS_doVBlankProcess();
        loops++;
    }

    return 0;
}
