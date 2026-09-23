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
// Controls
//   START     play the BGM; with several songs, the NEXT song
//   DOWN      stop everything
//   A / B     an FM effect, at a low and a high priority
//   C         a PSG effect        UP     a PCM effect
//   LEFT/RIGHT  the score's value slots, held like a knob
//
// It is written to run with ANY score. The effect, value-slot and song-change
// demos need scores that carry them, which is what example/demo.mmlisp and
// demo-b.mmlisp are — two songs with a BGM on FM, PSG and PCM, one effect for
// each kind, two value slots, and ONE sample bank between them
// (example/demo.bundle.json, built by tools/bundle.mjs):
//
//   node drv/tools/install-sgdk.mjs <proj> --example --bundle drv/sgdk/example/demo.bundle.json
//   make -f $GDK/makefile.gen EXTRA_FLAGS="-DMMLISP_SE_TRACKS=4 -DMMLISP_PCM_SAMPLES=1 \
//        -DMMLISP_SONG_LIST=demo_mmb,demo_b_mmb"
//
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

// ── Songs ───────────────────────────────────────────────────────────────────
// The scores this ROM carries, as rescomp names them: one MMB each. A resident
// score is one MMB (driver.md §2.3), so a song change is MMLisp_loadScore —
// the sequencer resets, the music stops, and the score's setup is primed
// onto the wire; start it when MMLisp_isSettled. What the songs SHARE is the
// sample bank: MMLisp_setSampleBank is remembered and re-published by every
// load, so a bundle's songs (tools/bundle.mjs) ship their PCM once. They are
// also baked for one engine image, so the load never reboots the Z80.
#ifndef MMLISP_SONG_LIST
#define MMLISP_SONG_LIST song_mmb
#endif
static const u8* const SONGS[] = { MMLISP_SONG_LIST };
#define SONG_COUNT ((u8)(sizeof SONGS / sizeof SONGS[0]))

// ── Sound effects (driver.md §2.5) ──────────────────────────────────────────
// HOW MANY TRACKS AT THE END OF THE SCORE ARE SOUND EFFECTS. They are the ones
// the BGM buttons must NOT start, and the ones A and B fire with
// MMLisp_startSe. 0 — the default — means the score is all BGM and those two
// buttons do nothing, which is what every other score in this repo wants.
//
// The driver has no idea which track is an SE: `startTrack` and `startSe` are
// two ways to start the same track, and which one a track deserves is the
// game's knowledge, not the score's.
#ifndef MMLISP_SE_TRACKS
#define MMLISP_SE_TRACKS 0
#endif

// The priorities A and B fire at. Against an effect already sounding on that
// channel the lower one is DROPPED — and dropping it leaves the one playing
// completely alone — while the equal-or-higher one takes the channel over and
// inherits its duty to hand the BGM back. Press A then B to hear the takeover,
// B then A to hear the drop: in both cases the BGM's held note returns, re-keyed
// mid-sustain, when the LAST effect ends.
//
// Priority only arbitrates BETWEEN EFFECTS ON ONE CHANNEL. The PSG and PCM
// effects below sit on channels of their own, so they never meet these two and
// their own priority is free.
#define SE_PRIO_LOW  4
#define SE_PRIO_HIGH 9
#define SE_PRIO_ONE  5

// Which effect each button fires, as an index into the run of effect tracks at
// the end of the score. demo.mmlisp orders them FM, FM, PSG, PCM.
#define SE_FM   0
#define SE_FM2  1
#define SE_PSG  2
#define SE_PCM  3

// ── Value slots (driver.md §6.4) ────────────────────────────────────────────
// The score's `(def-val …)` declarations, in declaration order. demo.mmlisp
// names these `vib` and `lvl`; a score without them simply never reads what we
// write here, so driving them costs nothing and breaks nothing.
//
// ONE KNOB DRIVES BOTH, on purpose — the two differ in WHEN the score reads
// them, and hearing that difference in a single gesture is the point:
//
//   VAL_VIB is a scaled macro's depth, `(macro :pitch (* <signal> $vib))`. The
//   driver re-reads it once per macro step, which at the default step is every
//   frame, so the arp's vibrato follows your thumb THROUGH a sounding note.
//
//   VAL_LVL is a plain `:vol $lvl` in the event stream, read when the sequencer
//   walks over that opcode. The bass changes level at the next pass of its
//   loop, not now.
//
// A scaled macro is the only path that moves a note already sounding.
// Everything else — the param opcodes, a sweep's endpoints — samples the slot
// when the stream fires it, which is per note or per bar.
#define VAL_VIB 0
#define VAL_LVL 1
#define INTENSITY_MAX 255
#define LVL_MIN 8
#define LVL_MAX 31

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

#define MAX_SHOWN_TRACKS 10

static void drawHex(u32 value, u16 digits, u16 x, u16 y)
{
    char hex[16];   // intToHex writes up to 8 digits + NUL
    intToHex(value, hex, digits);
    VDP_drawText(hex, x, y);
}

// The BGM tracks: everything the score declares except the sound effects, which
// sit at the end of the list.
static u8 bgmTrackCount(void)
{
    u8 n = MMLisp_trackCount();
    // >=, not >: a score that is ALL effect tracks has no BGM, and starting
    // them here would start them with startTrack — evicting, never restoring.
    return (n >= MMLISP_SE_TRACKS) ? (u8)(n - MMLISP_SE_TRACKS) : n;
}

static void playBgm(void)
{
    // Every track in one frame. Each track's clock starts on the frame it was
    // set up in, so spreading the starts would leave them permanently out of
    // phase — and the setup frame is silent anyway (driver.md §4.2).
    for (u8 i = 0; i < bgmTrackCount(); i++)
        MMLisp_startTrack(MMLisp_trackId(i));
}

static void stopAll(void)
{
    for (u8 i = 0; i < MMLisp_trackCount(); i++)
        MMLisp_stopTrack(MMLisp_trackId(i));
}

static u8 song = 0;            // which of SONGS is loaded
static bool starting = FALSE;  // a load is settling; start the BGM once it has
static bool playing = FALSE;   // the BGM has been started and not stopped.
                               // Kept here rather than read back from a track:
                               // a BGM track an effect has displaced reads
                               // INACTIVE while the effect sounds (§2.5), and
                               // START would then restart the song instead of
                               // moving to the next one.

static bool loadSong(u8 i)
{
    song = i;
    return MMLisp_loadScore(SONGS[i]);
}

// Fire the i-th sound-effect track. MMLisp_startSe, not startTrack: startTrack
// would EVICT the BGM track on that channel and the music would never come
// back, which is the whole difference between a scene change and an effect.
static void fireSe(u8 i, u8 prio)
{
    u8 n = MMLisp_trackCount();
    if (i >= MMLISP_SE_TRACKS || n < MMLISP_SE_TRACKS) return;
    MMLisp_startSe(MMLisp_trackId((u8)(n - MMLISP_SE_TRACKS + i)), prio);
}

// A held direction moves a slot every frame, so a full sweep takes about a
// second. Clamped here, because the driver does not clamp to the score's
// declared range — it only clamps at the register write.
static s16 nudge(s16 v, s16 delta, s16 max)
{
    v += delta;
    if (v < 0) v = 0;
    if (v > max) v = max;
    return v;
}

// The bass level the knob asks for. Kept off the floor so the bass never
// vanishes entirely — a knob that mutes a part reads as a bug, not a mix.
static s16 lvlFor(s16 intensity)
{
    return (s16)(LVL_MIN + ((s32)intensity * (LVL_MAX - LVL_MIN)) / INTENSITY_MAX);
}

int main(bool hardReset)
{
    // Upload and boot the Z80 engine: the one-voice pair-transport engine,
    // ~7 KB with its level tables.
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

    if (!loadSong(0))
    {
        VDP_drawText("BAD MMB", 2, 2);
        while (TRUE) SYS_doVBlankProcess();
    }

    // THE PUMP (mmlispdrv.h): the VBlank callback carries the pairs to the
    // Z80; MMLisp_frame() below only renders. A game with its own VBlank
    // callback calls MMLisp_pump() from it instead. The horizontal interrupt
    // is untouched — it stays the game's.
    MMLisp_attachInterrupts();

#if MMLISP_AUTOPLAY
    // The headless gate (drv/tools/sgdk-gate.mjs) grades the driver's own bus
    // stops; SGDK's joypad reads halt the Z80 too (HALT_Z80_ON_IO), so the
    // autoplay build reads no pads.
    JOY_setSupport(PORT_1, JOY_SUPPORT_OFF);
    JOY_setSupport(PORT_2, JOY_SUPPORT_OFF);
#endif

    // The score plays PCM and no sample bank was published: every PCM note is
    // dropped. Warn, but play — running a score without its PCM is a useful
    // thing to be able to do on purpose. A bank baked for another engine image
    // reads the same way (the sequencer refused it); MMLispStats.bank tells the
    // two apart.
    const bool noSamples = MMLisp_needsSampleBank();

    // THE SLOTS ARE SEEDED BY THE LOAD, not by starting a track, so read one
    // back here rather than assuming: a score that declares none returns 0, and
    // starting and stopping tracks later never resets what we set.
    s16 intensity = MMLisp_getVal(VAL_VIB);

    {
        MMLispStats st0;
        MMLisp_readStats(&st0);
        VDP_drawText(st0.bank < 0 ? "READY (BANK REJECTED: PCM MUTE)"
                     : noSamples ? "READY (NO SAMPLE BANK: PCM MUTE)" : "MMLispDRV ready", 2, 2);
    }
    VDP_drawText(SONG_COUNT > 1 ? "START next song DOWN stop" : "START bgm       DOWN stop", 2, 3);
    VDP_drawText("A/B fm se  C psg  UP pcm", 2, 4);
    VDP_drawText("left/right intensity", 2, 5);
    VDP_drawText("pad:", 2, 6);
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
    VDP_drawText("host x256:", 2, 8);
    VDP_drawText("frames:", 19, 8);
    VDP_drawText("pend:", 2, 9);
    VDP_drawText("ovf:", 12, 9);
    VDP_drawText("flt:", 22, 9);
    VDP_drawText("grabs:", 2, 10);
    VDP_drawText("pairs:", 14, 10);
    VDP_drawText("fifo:", 28, 10);
    VDP_drawText("late:", 2, 11);
    VDP_drawText("intensity:", 2, 13);
    VDP_drawText("bass vol:", 15, 13);
    VDP_drawText("track active:", 2, 15);
    VDP_drawText("trig:", 2, 16);

    u16 prev = 0;
    u16 loops = 0;
    u32 baseTimer = vtimer;
    u32 markTimer = vtimer;
    MMLispStats st;

    MMLisp_setVal(VAL_LVL, lvlFor(intensity));
    drawHex((u16)intensity, 2, 13, 13);
    drawHex((u16)lvlFor(intensity), 2, 25, 13);

#if MMLISP_AUTOPLAY
    // The load primed the score (mmlispdrv.h): let its writes reach the chip
    // before the music starts, so the first notes do not wait behind them.
    for (u16 i = 0; i < 60 && !MMLisp_isSettled(); i++)
    {
        MMLisp_frame();
        SYS_doVBlankProcess();
    }
    playing = TRUE;
    playBgm();
    VDP_drawText("PLAY", 2, 18);
#endif

    while (TRUE)
    {
        u16 joy = JOY_readJoypad(JOY_1);
        u16 pressed = joy & ~prev;      // edge, not level

        // Input feedback, drawn only when the pad changes — without it there is
        // no way to tell "the press never arrived" from "the driver ignored it".
        if (joy != prev) drawHex(joy, 4, 7, 6);
        prev = joy;

        if (pressed & BUTTON_START)
        {
            baseTimer = vtimer;
            loops = 0;
            if (SONG_COUNT > 1 && !starting && playing)
            {
                // The next song. The load resets the sequencer — the music
                // stops, and the value slots go back to the score's inits, so
                // the knob is written again — and re-publishes the bank. Every
                // song of a bundle boots the same engine image, so the Z80
                // stays up; the wait below is only for the new score's setup
                // writes to leave the wire.
                if (!loadSong((u8)((song + 1) % SONG_COUNT)))
                {
                    // A bad MMB at this point is a build mistake, not a
                    // runtime one, but starting tracks against a sequencer
                    // that refused the load would play the PREVIOUS song's
                    // stream against this song's track table.
                    VDP_drawText("BAD MMB", 2, 18);
                    playing = FALSE;
                    prev = joy;
                    continue;
                }
                MMLisp_setVal(VAL_VIB, intensity);
                MMLisp_setVal(VAL_LVL, lvlFor(intensity));
            }
            starting = TRUE;
            VDP_drawText("LOAD", 2, 18);
            drawHex(song, 1, 7, 18);
        }

        // A started song plays once its load has settled (README "Load first,
        // start when settled"). For the first song that is a frame or two.
        if (starting && MMLisp_isSettled())
        {
            starting = FALSE;
            playing = TRUE;
            playBgm();
            VDP_drawText("PLAY", 2, 18);
        }

        // The effects, one per kind of voice. The BGM keeps running throughout:
        // the track on the stolen channel is suspended, not stopped, and it
        // picks up where it was. On PCM there is no owning track to suspend —
        // the effect overwrites the soft-mix voice, and the BGM's loop is
        // started again when it ends.
        if (pressed & BUTTON_A)  fireSe(SE_FM,  SE_PRIO_LOW);
        if (pressed & BUTTON_B)  fireSe(SE_FM2, SE_PRIO_HIGH);
        if (pressed & BUTTON_C)  fireSe(SE_PSG, SE_PRIO_ONE);
        if (pressed & BUTTON_UP) fireSe(SE_PCM, SE_PRIO_ONE);

        if (pressed & BUTTON_DOWN)
        {
            stopAll();
            starting = FALSE;
            playing = FALSE;
            VDP_drawText("STOP", 2, 18);
        }

        // ── The value slots, from the d-pad ─────────────────────────────────
        // Held, not edge: a slot is a knob, not a command. setVal is a plain
        // store into the sequencer's own RAM — no bus grab, no Z80 — so writing
        // one every frame costs nothing worth counting.
        //
        // Both slots are written together. The vibrato answers on the next
        // frame and the bass level at the next bar, from the same press: that
        // gap is not latency, it is where each slot is read.
        {
            const s16 was = intensity;
            if (joy & BUTTON_RIGHT) intensity = nudge(intensity, +4, INTENSITY_MAX);
            if (joy & BUTTON_LEFT)  intensity = nudge(intensity, -4, INTENSITY_MAX);
            if (intensity != was)
            {
                const s16 lvl = lvlFor(intensity);
                MMLisp_setVal(VAL_VIB, intensity);
                MMLisp_setVal(VAL_LVL, lvl);
                drawHex((u16)intensity, 2, 13, 13);
                drawHex((u16)lvl, 2, 25, 13);
            }
        }

        // The readout costs no bus grab — every number is the host's own — so
        // once a second is a choice of legibility, not of interference.
        if ((u16)(vtimer - markTimer) >= 60)
        {
            MMLisp_readStats(&st);
            const u32 elapsed = vtimer - baseTimer;
            drawHex(elapsed ? ((u32)loops << 8) / elapsed : 0, 4, 13, 8);
            drawHex(st.rendered, 4, 27, 8);
            drawHex(st.pending, 4, 7, 9);
            drawHex(st.overflow, 4, 16, 9);
            drawHex(st.faults, 4, 27, 9);
            drawHex(st.grabs, 4, 8, 10);
            drawHex(st.pairsWritten, 4, 20, 10);
            drawHex(st.fifoLo, 2, 33, 10);
            drawHex(st.late, 4, 8, 11);
            markTimer = vtimer;

            // Which tracks hold a channel right now. A BGM track an effect has
            // displaced reads INACTIVE while the effect sounds and comes back
            // on its own — that flicker is the suspend/restore, on screen.
            u8 n = MMLisp_trackCount();
            if (n > MAX_SHOWN_TRACKS) n = MAX_SHOWN_TRACKS;
            for (u8 i = 0; i < n; i++)
                drawHex(MMLisp_trackActive(MMLisp_trackId(i)) ? 1 : 0, 1, 17 + i, 15);
        }

#if MMLISP_BURN
        {
            static u16 frameNo;
            volatile u16 sink = 0;
            u16 n = ((++frameNo & 63) == 0) ? 2 * MMLISP_BURN : MMLISP_BURN;
            while (n--) sink++;
        }
#endif

        // The trig bytes, every frame — this is what a game watches to fire a
        // visual on a cue. A trigger is "the byte differs from the one I last
        // saw", so the same id firing again (a cue inside a loop) still counts.
        {
            static u8 seen[MAX_SHOWN_TRACKS];
            u8 n = MMLisp_trackCount();
            if (n > MAX_SHOWN_TRACKS) n = MAX_SHOWN_TRACKS;
            for (u8 i = 0; i < n; i++)
            {
                u8 b = MMLisp_trig(MMLisp_trackId(i));
                if (b == seen[i]) continue;
                seen[i] = b;
                drawHex(b & 0x3f, 2, 8 + 3 * i, 16); // the id that just fired
            }
        }

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
