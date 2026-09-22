// MMLispDRV — SGDK (Sega Genesis Dev Kit) host API.
//
// THE SPLIT (docs/driver.md §1.1): the 68000 runs the sequencer, the Z80 is a
// PCM + chip-write engine. THE TRANSPORT (driver.md §5): the Z80 keeps a fixed
// DAC clock from its own instruction stream — no interrupt, no timer — and
// consumes 2-byte {op, val} PAIRS from a page in its RAM. A pair is an FM
// register write or one byte of a PCM voice's state; PSG bytes go straight
// from the 68000 to $C00011. The sequencer's calls below are ordinary C calls;
// what crosses the bus is pairs, in one bus grab a frame.
//
// ONE GRAB A FRAME, FROM THE VERTICAL INTERRUPT — the one thing a game has to
// arrange, and it is the interrupt every game already takes. A grab carries
// sixteen pairs, so the wire is 960 register writes a second. So:
//
//     MMLisp_attachInterrupts()  once, after MMLisp_init: the pump becomes the
//                                VBlank callback. The horizontal interrupt is
//                                not touched — it stays yours
//     MMLisp_frame()             once a frame in your main loop: renders ahead
//                                into the queue; takes no bus
//
// THE TEMPO FOLLOWS THE VIDEO CLOCK, NOT THE MAIN LOOP. MMLisp_frame() renders
// each frame MMLISP_LEAD (default 1) frames before its time, and the pumps send
// only the frames whose time has come, counted from SGDK's vtimer. So a main
// loop that runs late — a heavy frame of the game, or of the music — delays
// nothing that was ready, and the next call catches up. A main loop more than
// three frames behind is taken as a stop (a load, a pause screen) and the music
// pauses with it rather than bursting through the missed frames.
//
// If your game has its own VBlank callback, skip the attach and call
// MMLisp_pump() from yours, once a frame. A pump that comes late (two frames
// after the last one) notices, copies nothing, and the next one catches up;
// the Z80 is never handed pairs behind its read index.
//
// BUS STOPS ARE NOT REPAID. The grab itself holds the bus about 45 µs, and
// SGDK halts the Z80 around every joypad read (HALT_Z80_ON_IO, ~350 68k cycles
// per 6-button port) and every VBlank DMA flush (HALT_Z80_ON_DMA, as long as
// the DMA). The DAC runs slow by the time the bus was held — it costs pitch,
// not a hole in the sound (drv/sgdk/README.md "Bus stops").
//
// PROFILE: one to three PCM voices, the count the score names — each count is
// its own Z80 image with its own DAC rate, booted by MMLisp_loadScore. Every
// note is baked at that rate; loops and releases are played by the engine.
// The sample bank must be the 32 KB `song.smp` the exporter writes for the
// score — its top page is the silence a parked voice reads.
#ifndef MMLISPDRV_H
#define MMLISPDRV_H

#include <genesis.h>

// ── Lifecycle ──────────────────────────────────────────────────────────────

// Upload the Z80 engine image, boot it, and wait (up to ~1 s) for its ready
// mark. Check MMLisp_isReady() afterwards: on a failed bring-up this returns
// with the engine dead rather than freezing the game. Call once at startup,
// before anything else here. While MMLispDRV owns the Z80 you must not use
// SGDK's own sound drivers; this one writes the YM2612 and PSG directly.
void MMLisp_init(void);

// True once the engine reported ready.
bool MMLisp_isReady(void);

// Publish the PCM sample bank: the 32 KB `song.smp` rescomp placed on a 32 KB
// boundary (`BIN song_smp "song.smp" 32768`). Sets the Z80's bank window to it
// (nine register writes inside one bus grab) and hands its directory to the
// sequencer. Call once after MMLisp_init and before starting a PCM track; with
// no bank published every PCM note is dropped and the song plays FM/PSG only.
void MMLisp_setSampleBank(const u8* smp);

// Load a score. `mmb` points at the MMB blob in ROM (no alignment needed).
// Loading resets all sequencer state and stops everything; one score is loaded
// at a time. Returns FALSE on a malformed blob.
//
// A SCORE IS BAKED FOR ONE VIDEO STANDARD. Its tempo and every macro, sweep
// and delay length are numbers of FRAMES, so an NTSC score on a PAL machine
// plays 20% slow and a PAL score on an NTSC machine 20% fast. This is not
// checked here — plenty of games ship one score and accept it, as the Mega
// Drive always has — so if you care, bake both and pick with
// MMLisp_scoreFrameHz() against SGDK's IS_PAL_SYSTEM.
//
// It also PRIMES the score: the chip's neutral patch and every track's leading
// setup (its voices and levels) are queued at once and leave for the chip over
// the next frames — keep calling MMLisp_frame() — so that starting the tracks
// later sends only what differs, and the first notes are not stuck behind a
// few hundred register writes. Load during a screen transition and start when
// MMLisp_isSettled() says the load has gone out (~16 frames for a six-channel
// song); starting sooner is correct, only the first notes come later.
bool MMLisp_loadScore(const u8* mmb);

// TRUE when nothing the load (or anything since) queued is still waiting for
// the wire.
bool MMLisp_isSettled(void);

// ── The hooks ─────────────────────────────────────────────────────────────

// Install the pump (see the top of this file). Replaces SGDK's VBlank
// callback; the horizontal interrupt is not touched.
void MMLisp_attachInterrupts(void);

// Render the score ahead into the pair queue: up to MMLISP_LEAD frames past
// the ones whose time has come (normally one frame a call; more after a late
// call). Once a frame, in the main loop; takes no bus. Place it after the
// control calls below: they take effect on the next frame it renders.
void MMLisp_frame(void);

// One grab: read the engine's index, write up to sixteen pairs of the frames
// whose time has come ahead of it, then write the PSG bytes released for the
// last frame. Once a frame, from the vertical interrupt
// (MMLisp_attachInterrupts does it). Each call stops the Z80 for about 2,400
// master clocks (~45 µs), which nothing repays. A pump that overlaps another
// returns at once, and a bus the interrupted code holds is left held.
void MMLisp_pump(void);

// ── Track control (driver.md §6.5) ─────────────────────────────────────────
// Every call takes effect on the next frame MMLisp_frame renders, which is
// played MMLISP_LEAD frames later; its FM writes reach the chip within about a
// half-frame of that frame's time.

// Start a track by its MMB track id. Claiming a channel evicts its current
// owner and resets the channel's level state. Start each track of a score with
// its own call — there is no start-burst limit.
void MMLisp_startTrack(u8 track_id);

// Stop a track: key-off (the release tail runs out), free its channel, idle it.
void MMLisp_stopTrack(u8 track_id);

// How many tracks the loaded score has, and the id of the i-th one:
//
//     for (u8 i = 0; i < MMLisp_trackCount(); i++)
//         MMLisp_startTrack(MMLisp_trackId(i));
//
// A hardcoded count that stops short never starts the tail of the list, with
// no error — and PCM tracks tend to sit at the end.
u8 MMLisp_trackCount(void);
u8 MMLisp_trackId(u8 index);

// Key-off one channel without stopping its track.
void MMLisp_keyOff(u8 channel_id);

// One-shot absolute parameter write on a channel (docs/opcodes.md §7).
void MMLisp_setParam(u8 channel_id, u8 target_id, s8 value);

// Fade a track's volume to silence over `frames` frames, then stop it.
void MMLisp_fadeTrack(u8 track_id, u16 frames);

// Dynamic value slots (driver.md §6.4): 16 i16 slots the score reads via
// `$name`. Plain 68k memory.
void MMLisp_setVal(u8 slot, s16 value);
s16 MMLisp_getVal(u8 slot);

// ── Status ─────────────────────────────────────────────────────────────────

// True when the loaded score plays PCM but no sample bank was published — the
// one misconfiguration that fails entirely silently.
bool MMLisp_needsSampleBank(void);

// True while the track is running (dispatching or holding).
bool MMLisp_trackActive(u8 track_id);

// The track's trig status byte — `(trig N)` music->game sync (opcodes.md 0x42).
//
//   bits 5-0  the id of the trigger last passed (0..63)
//   bits 7-6  a firing counter: 1, 2, 3, 1, ... starting from 0
//
// so 0x00 means "this track has not passed a trigger yet", which a game can
// tell apart from `(trig 0)`. Poll it and compare with the byte you last saw:
// any difference means a trigger fired, INCLUDING the same id firing again,
// which is what a cue at a loop point does. Within one frame the last trigger
// wins. Reading does not clear it. Returns 0 for a track id that is not loaded.
//
// What it lags: the sequencer renders MMLISP_LEAD frames ahead, so the byte
// moves before the trigger is heard — compare MMLisp_renderedFrames against
// MMLispStats.due if a visual has to land ON the beat rather than near it.
u8 MMLisp_trig(u8 track_id);

// The video standard the loaded score was baked for: 60 or 50 (MMB header
// flags bit 1, PAL_TIMEBASE). 0 when no score is loaded. The sequencer itself
// reads no frame rate — it counts frames, and every frame-counted number
// arrives baked — so this is here for the host to match a score to a machine:
//
//   MMLisp_loadScore(IS_PAL_SYSTEM ? song_pal : song_ntsc);
//
u8 MMLisp_scoreFrameHz(void);

// Frames rendered since the score was loaded. They are rendered MMLISP_LEAD
// frames ahead of their time, and what the player hears runs a further ~16 ms
// behind that (a half-frame grab period plus the pair page); anything that has
// to line up with the music compares against MMLispStats.due instead.
u16 MMLisp_renderedFrames(void);

typedef struct {
    u16 rendered;      // frames rendered (MMLisp_renderedFrames)
    u16 pending;       // pairs waiting on the 68000 for the wire. Steady state is
                       // a handful; a number that climbs means the score asks for
                       // more register writes a second than the wire carries
                       // (960) — or the pump is not being called
    u16 grabs;         // bus grabs so far (should be ~60 a second)
    u16 late;          // grabs that found the engine past their destination and
                       // copied nothing (the next grab carried the pairs). A
                       // few is harmless; steadily climbing means frames are
                       // being missed
    u16 pairsWritten;  // pairs put on the wire so far
    u16 overflow;      // pairs that did not fit the 1,024-entry queue: LOST writes.
                       // Zero, or the engine has been starved of pumps
    u16 faults;        // PCM commands for a voice the booted image does not have:
                       // zero, or the score and its image disagree
    u8  image;         // PCM voices of the booted engine image
    u16 due;           // frames whose time has come (vtimer since the load, less
                       // pauses); rendered - due is the lead, normally MMLISP_LEAD
    u16 pauses;        // times the main loop fell more than three frames behind
                       // and the music paused with it
    u8  fifoLo;        // the engine's own index, as last read: 0..254, even, moving
} MMLispStats;

// The host's own counters — nothing here touches the Z80.
void MMLisp_readStats(MMLispStats* out);

#endif // MMLISPDRV_H
