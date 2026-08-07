// Minimal SGDK program that plays an MMLisp score through MMLispDRV.
//
// Build layout (see drv/sgdk/README.md):
//   src/main.c          this file
//   src/mmlispdrv.c     the host glue      \  copied by
//   src/mmlispseq.c     the sequencer       ) drv/tools/install-sgdk.mjs
//   src/tables.c        its constant tables/
//   inc/mmlispdrv.h  inc/mmlispseq.h  inc/mmlispdrv_bin.h (generated)
//   res/song.res        the BIN resource for the MMB (no alignment needed)
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
//
// Get it wrong and the program below refuses to start and says so — the failure
// is otherwise completely silent (the song plays, the drums do not).
#ifndef MMLISP_PCM_SAMPLES          // (or pass -DMMLISP_PCM_SAMPLES=1)
#define MMLISP_PCM_SAMPLES 0
#endif

// There is deliberately no TRACK_COUNT here. The MMB knows how many tracks it
// has, so asking it (MMLisp_trackCount) removes a constant that has to be kept
// in step with the score by hand — and getting that constant wrong is silent:
// the tail of the track list simply never starts, and PCM tracks tend to sit at
// the end, so it presents as "the drums are missing".
#define MAX_SHOWN_TRACKS 10

static void drawHex(u32 value, u16 digits, u16 x, u16 y)
{
    char hex[16];   // intToHex writes up to 8 digits + NUL
    intToHex(value, hex, digits);
    VDP_drawText(hex, x, y);
}

int main(bool hardReset)
{
    // Upload and boot the Z80 engine. No overlay blob and no banks: post-split
    // the engine is one ~2.6 KB resident image (docs/driver.md §5.2).
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

    // The score plays PCM and no sample bank was published: every PCM note is
    // dropped and the DAC never enabled. Warn, but play — running the score
    // without its PCM is a useful thing to be able to do on purpose.
    const bool noSamples = MMLisp_needsSampleBank();

    VDP_drawText(noSamples ? "READY (NO SAMPLE BANK: PCM MUTE)" : "MMLispDRV ready", 2, 2);
    VDP_drawText("A/START play  B stop  C stat", 2, 3);
    VDP_drawText("pad:", 2, 5);
    // ── The tempo readout ───────────────────────────────────────────────────
    // `music` is the music's real speed: frames the engine consumed against
    // frames that actually elapsed, x256, so 0x100 is dead on and 0x080 is half
    // speed. The reference is SGDK's `vtimer`, which is incremented from the
    // vertical interrupt and therefore keeps counting when THIS LOOP misses a
    // frame. Measuring against a loop counter instead makes a slow main loop
    // read as fast music, which is exactly the wrong answer.
    //
    // `host` is this loop's own health on the same scale — 0x100 means one
    // iteration per frame. If it is low, the 68k side is the problem before any
    // of the driver's numbers mean anything.
    //
    // `starv` then says WHOSE FAULT a low `music` is, and it is the whole
    // diagnosis because the two answers have opposite fixes:
    //
    //   music < 0x100 and starv/s > 0   the ring ran DRY — the 68k side is late.
    //                                   Check `host` first; if that is low the
    //                                   fix is in this loop, not in the driver.
    //                                   Otherwise: deeper RING_DEPTH, or less
    //                                   work per frame on the 68k.
    //   music < 0x100 and starv/s == 0  the Z80 is not taking every interrupt —
    //                                   its frame is over budget (§5.1.3).
    //                                   Fewer PCM voices, or a lower mix rate.
    //
    // `starv` alone is cumulative, and cumulative can only say THAT the ring ran
    // dry, never whether it still is — a number that climbed once and stopped
    // looks identical to one climbing now. `starv/s` is the one that answers it.
    // `audible` is the raw consumed-frame count behind `music`.
    VDP_drawText("music x256:", 2, 7);
    VDP_drawText("host x256:", 19, 7);
    // Cumulative tells you THAT frames are being lost; it cannot tell you WHEN,
    // and "when" is the whole diagnosis. A steady 0x0F8 every second means a
    // per-frame cost sitting just over the line; 0x100 most seconds with
    // occasional dips means specific events (a loop point, a note-on) and the
    // fix is somewhere else entirely. `lost/s` is the same thing as a raw count.
    VDP_drawText("1s:", 2, 8);
    VDP_drawText("worst 1s:", 12, 8);
    VDP_drawText("lost/s:", 26, 8);
    VDP_drawText("starv:", 2, 9);
    VDP_drawText("audible:", 14, 9);
    VDP_drawText("starv/s:", 28, 9);
    // The decision table on screen, because this is read while looking at the
    // machine and not at the source.
    VDP_drawText("music<100: starv/s>0=68k  =0=z80", 2, 10);
    VDP_drawText("track active:", 2, 12);

    u16 prev = 0;
    // Sampled rarely and on purpose. Reading the counters stops the Z80 for the
    // length of a bus grab, so a per-frame readout costs the engine frames and
    // then reports them as overruns — the instrument becoming the fault it
    // measures. Once every 32 frames is two orders below that.
    u16  loops       = 0;
    u32  baseTimer   = vtimer;
    u16  baseAudible = 0;
    u32  markTimer   = vtimer;   // start of the current one-second window
    u16  markAudible = 0;
    u16  markStarved = 0;
    u16  worst1s     = 0x100;
    MMLispStats st = { 0, 0 };

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
            // Both clocks start together, or the ratio is measuring the silence
            // before the music as well as the music.
            MMLisp_readStats(&st);
            baseTimer   = vtimer;
            baseAudible = st.audible;
            markTimer   = vtimer;
            markAudible = st.audible;
            markStarved = st.starved;
            worst1s     = 0x100;
            loops       = 0;
            // Every track in one frame. Each track's clock starts on the frame
            // it was set up in, so spreading the starts would leave them
            // permanently out of phase — and the setup frame is silent anyway
            // (§4.2), so they all begin together on the next one. There is no
            // mailbox ring to overflow now, so track count does not matter.
            for (u8 i = 0; i < MMLisp_trackCount(); i++)
                MMLisp_startTrack(MMLisp_trackId(i));
            VDP_drawText("PLAY", 2, 17);
        }

        if (pressed & BUTTON_B)
        {
            for (u8 i = 0; i < MMLisp_trackCount(); i++)
                MMLisp_stopTrack(MMLisp_trackId(i));
            VDP_drawText("STOP", 2, 17);
        }

        // One bus grab per WINDOW, not per frame: the Z80 stops while the
        // 68000 holds its bus, so a per-frame readout costs the engine the very
        // frames it then reports. One second is two orders below that.
        if ((u16)(vtimer - markTimer) >= 60)
        {
            MMLisp_readStats(&st);
            const u32 win  = vtimer - markTimer;             // real frames
            const u16 got  = (u16)(st.audible - markAudible); // consumed in them
            const u16 now  = (u16)(((u32)got << 8) / win);
            if (now < worst1s) worst1s = now;
            const u32 elapsed = vtimer - baseTimer;
            const u16 music   = (u16)(st.audible - baseAudible);
            drawHex(elapsed ? ((u32)music << 8) / elapsed : 0, 4, 14, 7);
            drawHex(elapsed ? ((u32)loops << 8) / elapsed : 0, 4, 30, 7);
            drawHex(now, 4, 6, 8);
            drawHex(worst1s, 4, 22, 8);
            drawHex(win > got ? win - got : 0, 4, 34, 8);
            drawHex(st.starved, 4, 9, 9);
            drawHex(st.audible, 4, 23, 9);
            drawHex((u16)(st.starved - markStarved), 4, 36, 9);
            markTimer   = vtimer;
            markAudible = st.audible;
            markStarved = st.starved;
        }

        if (pressed & BUTTON_C)
        {
            u8 n = MMLisp_trackCount();
            if (n > MAX_SHOWN_TRACKS) n = MAX_SHOWN_TRACKS;
            for (u8 i = 0; i < n; i++)
                drawHex(MMLisp_trackActive(MMLisp_trackId(i)) ? 1 : 0, 1, 17 + i, 12);
        }

        // ── The one hard rule: once per frame, and last ──────────────────────
        // Control calls above take effect on the next frame RENDERED, so putting
        // this after them costs no extra latency (driver.md §6.6). It tops the
        // ring up rather than rendering exactly one slot, so a frame you overran
        // is absorbed and then refilled with no special handling here.
        MMLisp_frame();

        SYS_doVBlankProcess();
        loops++;
    }

    return 0;
}
