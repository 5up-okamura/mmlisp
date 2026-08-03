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
#include "song.h"        // rescomp: `song_mmb`

// Track ids come from the compile step, which prints the whole list:
//   node drv/tools/mmb-build.mjs mysong.mmlisp res/song.mmb
// (examples/source/demo1.mmlisp compiles to 5 tracks, ids 0..4.) Set this to
// that count — a smaller value silently leaves the tail of the list unstarted,
// and PCM tracks tend to sit at the end.
#define TRACK_COUNT 5

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

    // A score with `def :sample` also ships res/song.smp on its own 32 KB-aligned
    // ROM bank. Uncomment BOTH this and the song.smp BIN line in song.res —
    // either one alone leaves every PCM note dropped, with the song playing
    // FM/PSG only. (demo1 has no PCM, so both ship commented out.)
    //   MMLisp_setSampleBank(song_smp);

    if (!MMLisp_loadScore(song_mmb))
    {
        VDP_drawText("BAD MMB", 2, 2);
        while (TRUE) SYS_doVBlankProcess();
    }

    // …and this is why the reminder above is not enough on its own. The score
    // says it plays PCM and no bank was published, which is silent by nature —
    // so say it out loud instead of letting it be chased as a missing part.
    if (MMLisp_needsSampleBank())
        VDP_drawText("!! PCM SCORE, NO SAMPLE BANK", 2, 19);

    VDP_drawText("MMLispDRV ready", 2, 2);
    VDP_drawText("A/START play  B stop  C stat", 2, 3);
    VDP_drawText("pad:", 2, 5);
    VDP_drawText("audible frame:", 2, 7);
    VDP_drawText("starved:", 18, 7);
    VDP_drawText("track active:", 2, 8);

    u16 prev = 0;

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
            // Every track in one frame. Each track's clock starts on the frame
            // it was set up in, so spreading the starts would leave them
            // permanently out of phase — and the setup frame is silent anyway
            // (§4.2), so they all begin together on the next one. There is no
            // mailbox ring to overflow now, so track count does not matter.
            for (u8 id = 0; id < TRACK_COUNT; id++) MMLisp_startTrack(id);
            VDP_drawText("PLAY", 2, 17);
        }

        if (pressed & BUTTON_B)
        {
            for (u8 id = 0; id < TRACK_COUNT; id++) MMLisp_stopTrack(id);
            VDP_drawText("STOP", 2, 17);
        }

        // Bring-up readout. Post-split almost all of it is 68k memory, so this
        // is just function calls — the pre-split version of this example had to
        // halt the Z80 and read a dozen hardcoded RAM offsets, and doing that
        // every frame made the driver miss its own interrupts. Only the audible
        // frame counter still crosses the bus; if it is not climbing, the Z80 is
        // not taking its 60 Hz interrupt.
        if (pressed & BUTTON_C)
        {
            drawHex(MMLisp_audibleFrame(), 4, 16, 7);
            // Should stay 0. Climbing = the ring ran dry, i.e. MMLisp_frame did
            // not run in time — which is exactly what an uneven tempo is.
            drawHex(MMLisp_starvedFrames(), 4, 27, 7);
            for (u8 id = 0; id < TRACK_COUNT; id++)
                drawHex(MMLisp_trackActive(id) ? 1 : 0, 1, 17 + id, 8);
        }

        // ── The one hard rule: once per frame, and last ──────────────────────
        // Control calls above take effect on the next frame RENDERED, so putting
        // this after them costs no extra latency (driver.md §6.6). It tops the
        // ring up rather than rendering exactly one slot, so a frame you overran
        // is absorbed and then refilled with no special handling here.
        MMLisp_frame();

        SYS_doVBlankProcess();
    }

    return 0;
}
