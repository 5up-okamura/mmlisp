// The probe program: start every track, run, and publish what happened into a
// struct in work RAM.
//
// It is the example program (drv/sgdk/example/main.c) with the pad and the
// screen taken out and a mailbox put in, because the numbers have to leave the
// machine without anyone reading them off a display. The libretro frontend
// (drv/blastem/host.c) reads work RAM straight out of the core, so publishing
// costs the 68000 four word writes a second and perturbs nothing.
//
// What it deliberately KEEPS from the example: the order of the frame (control
// first, MMLisp_frame last, then wait), the one-bus-grab-per-second stats
// discipline, and measuring against vtimer rather than a loop counter. Those
// are the parts that decide whether the numbers mean anything.
#include "genesis.h"
#include "mmlispdrv.h"
#include "probe.h"

extern const u8 song_mmb[];
extern const u8 song_smp[];
extern const u16 song_has_smp;

volatile probe_mailbox probe;

void waitVBlank(void);
void VDP_uploadFont(void);
void drawHex(u32 v, u16 digits, u16 x, u16 y);

int main(void)
{
    probe.magic = PROBE_MAGIC;
    VDP_uploadFont();

    // `stage` advances past each call that can hang or fault. A run that stops
    // reports the last one it got through, which is the difference between
    // "the MMB is bad" and "the 68000 took an address error inside mml_load".
    probe.stage = 1;
    MMLisp_init();
    if (!MMLisp_isReady()) { probe.status = PROBE_ST_INIT_FAILED; for (;;) waitVBlank(); }
    probe.status = PROBE_ST_READY;
    probe.stage = 2;

    if (song_has_smp) MMLisp_setSampleBank(song_smp);
    probe.stage = 3;

    if (!MMLisp_loadScore(song_mmb)) { probe.status = PROBE_ST_BAD_MMB; for (;;) waitVBlank(); }
    probe.status |= PROBE_ST_LOADED;
    probe.stage = 4;

    // A PCM score with no bank plays every note but the drums, silently. The
    // run is still worth having — that is how the FM side gets measured alone —
    // so this is a flag on the result, not a refusal.
    if (MMLisp_needsSampleBank()) probe.status |= PROBE_ST_PCM_MUTE;

    MMLispStats st = { 0, 0 };
    probe.track_count = MMLisp_trackCount();
    // Every track in the same frame: each track's clock starts in the frame it
    // was set up in, so staggered starts stay permanently out of phase.
    for (u8 i = 0; i < probe.track_count; i++) MMLisp_startTrack(MMLisp_trackId(i));
    probe.stage = 5;

    // BOTH CLOCKS START TOGETHER, and the engine's does not start at zero: it
    // has been consuming frames since MMLisp_init, through the score load, and
    // counting those against a window that begins here reads as music running
    // FAST — 0x114, 108%, which is not a thing that can happen. The example
    // program takes the same reading when PLAY is pressed; this one has no
    // button, so it takes it now.
    MMLisp_readStats(&st);
    const u32 base_vbl = vtimer;
    u32 mark_vbl  = vtimer;
    u16 base_audible = st.audible, mark_audible = st.audible,
        mark_starved = st.starved;
    u16 worst_1s = 0xFFFF;
    u32 loops = 0;

    for (;;)
    {
        // Once a second, not once a frame. Reading the counters holds the Z80
        // bus, so a per-frame readout costs the engine the very frames it then
        // reports — the instrument becoming the fault it measures.
        if ((u32)(vtimer - mark_vbl) >= 60)
        {
            MMLisp_readStats(&st);
            const u32 win = vtimer - mark_vbl;
            const u16 got = (u16)(st.audible - mark_audible);
            const u16 now = (u16)(((u32)got << 8) / win);
            if (now < worst_1s) worst_1s = now;

            const u32 elapsed = vtimer - base_vbl;
            probe.vblanks  = (u16)elapsed;
            probe.audible  = (u16)(st.audible - base_audible);
            probe.starved  = st.starved;
            probe.music256 = elapsed ? (u16)(((u32)probe.audible << 8) / elapsed) : 0;
            probe.host256  = elapsed ? (u16)((loops << 8) / elapsed) : 0;
            probe.worst_1s = worst_1s;
            probe.lost_1s  = (u16)(win > got ? win - got : 0);
            probe.starv_1s = (u16)(st.starved - mark_starved);
            probe.seconds++;

            drawHex(probe.music256, 4, 2, 2);
            drawHex(probe.host256,  4, 8, 2);
            drawHex(probe.lost_1s,  4, 14, 2);
            drawHex(probe.starv_1s, 4, 20, 2);

            mark_vbl     = vtimer;
            mark_audible = st.audible;
            mark_starved = st.starved;
        }

        // Once per frame and LAST: control calls take effect on the next frame
        // rendered, so nothing is gained by pumping earlier (driver.md §6.6).
        MMLisp_frame();
        probe.stage = 6;
        waitVBlank();
        loops++;
    }
}
