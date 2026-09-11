// MMLispDRV — SGDK (Sega Genesis Dev Kit) host API.
//
// THE SPLIT (docs/driver.md §1.1): the 68000 runs the sequencer, the Z80 is a
// PCM + chip-write engine. THE TRANSPORT (docs/dac-engine-implementation.md
// R28 §63): the Z80 keeps a fixed 9,987.57 Hz DAC clock from its own
// instruction stream — no interrupt, no timer — and consumes 2-byte {op, val}
// PAIRS from a page in its RAM, sixteen a lap of eighty samples. A pair is an
// FM register write or one byte of the PCM voice's state; PSG bytes go
// straight from the 68000 to $C00011. The sequencer's calls below are ordinary
// C calls; what crosses the bus is pairs, in bus grabs sized to what the
// engine's phase corrector can repay.
//
// TWO GRABS A FRAME, FROM INTERRUPTS — the one thing a game has to arrange. A
// grab carries at most five pairs, so the wire is ~600 register writes a second
// only when the bus is taken twice a frame, and the pairs land ahead of the
// engine only when the grabs are evenly spaced. So:
//
//     MMLisp_attachInterrupts()  once, after MMLisp_init: a pump becomes the
//                                VBlank callback and MMLisp_hint the HBlank one
//                                at line 93
//     MMLisp_frame()             once a frame in your main loop: renders the
//                                frame into the queue; takes no bus
//
// If your game has its own VBlank or HBlank callback, skip the attach and call
// MMLisp_pump() from yours — once in VBlank and once at line 88..98, so that the
// two are more than 80 samples (8.0 ms) apart both ways. A pump that
// comes late (a frame after the last one) notices, copies nothing, and the next
// one catches up; the Z80 is never handed pairs behind its read index.
//
// SGDK'S OWN BUS STOPS. SGDK halts the Z80 around every joypad read
// (HALT_Z80_ON_IO, ~350 68k cycles per 6-button port) and every VBlank DMA
// flush (HALT_Z80_ON_DMA, as long as the DMA). The engine's clock repays up to
// 1,500 master clocks of stop per 80 samples; beyond that the DAC runs slow by
// the unrepaid time (drv/sgdk/README.md "Bus stops").
//
// PROFILE: one PCM voice (`pcm1`), fixed pitch classes with 2^k octave steps,
// no sample loops (a looped sample plays through once); `pcm2`/`pcm3` and
// PCM_LOOP are dropped and counted (MMLispStats.dropped). The sample bank must
// be the 32 KB `song.smp` the exporter writes — its top page is the silence
// the voice parks in.
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
bool MMLisp_loadScore(const u8* mmb);

// ── The hooks ─────────────────────────────────────────────────────────────

// Install the two pumps (see the top of this file). Replaces SGDK's VBlank and
// HBlank callbacks and enables the horizontal interrupt.
void MMLisp_attachInterrupts(void);

// Render one frame of the score into the pair queue. Exactly once a frame, in
// the main loop; takes no bus. Place it after the control calls below: they
// take effect on the frame it renders.
void MMLisp_frame(void);

// One grab: read the engine's index, write up to five pairs ahead of it, then
// write the PSG bytes released for this half-frame. Twice a frame, from
// interrupts (MMLisp_attachInterrupts does it). Each call stops the Z80 for
// under 1,500 master clocks, which the engine repays. A pump that overlaps
// another returns at once, and a bus the interrupted code holds is left held.
void MMLisp_pump(void);

// MMLisp_pump as an interrupt function, for SYS_setHIntCallback() directly.
// SGDK's HInt vector jumps straight to the callback, so a plain function there
// crashes on its return. If you already have an HInt handler, call
// MMLisp_pump() from it instead.
HINTERRUPT_CALLBACK MMLisp_hint(void);

// ── Track control (driver.md §6.5) ─────────────────────────────────────────
// Every call takes effect on the next frame MMLisp_frame renders; its FM
// writes reach the chip within about a half-frame after that.

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

// Frames rendered since the score was loaded. The audible clock runs a fixed
// ~16 ms behind it (a half-frame grab period plus the pair page), so anything
// that has to line up with what the player hears compares against this.
u16 MMLisp_renderedFrames(void);

typedef struct {
    u16 rendered;      // frames rendered (MMLisp_renderedFrames)
    u16 pending;       // pairs waiting on the 68000 for the wire. Steady state is
                       // a handful; a number that climbs means the score asks for
                       // more register writes a second than two grabs a frame
                       // carry (~600) — or the pumps are not being called
    u16 grabs;         // bus grabs so far (should be ~120 a second)
    u16 late;          // grabs that found the engine past their destination and
                       // copied nothing (the next grab carried the pairs). A
                       // few is harmless; steadily climbing means the pumps are
                       // not evenly spaced
    u16 pairsWritten;  // pairs put on the wire so far
    u16 overflow;      // pairs that did not fit the 1,024-entry queue: LOST writes.
                       // Zero, or the engine has been starved of pumps
    u16 dropped;       // PCM commands for voices this profile does not have
                       // (pcm2/pcm3) or for sample loops
    u16 stepRounded;   // PCM starts whose increment was not a power of two —
                       // played at the nearest octave (the bake makes it exact)
    u8  fifoLo;        // the engine's own index, as last read: 0..254, even, moving
} MMLispStats;

// The host's own counters — nothing here touches the Z80.
void MMLisp_readStats(MMLispStats* out);

#endif // MMLISPDRV_H
