// MMLispDRV — SGDK (Sega Genesis Dev Kit) host API.
//
// POST-SPLIT (docs/driver.md §1.1): the 68000 runs the sequencer and the Z80 is
// a PCM mixer + chip-write engine. So the shape of this API changed even though
// the names did not — these are now ordinary C calls into the sequencer
// (mmlispseq.c, which the project compiles alongside this file), not commands
// posted across the bus. The one thing that does cross the bus is the per-frame
// slot: MMLisp_frame() renders write lists into a ring in Z80 RAM.
//
// The Z80 keeps the clock. It consumes exactly one slot per its own vblank, so
// a game frame that runs long eats into the ring's lookahead instead of
// stuttering the music.
//
// STATUS: the sequencer's output is verified against the JS reference on the
// host (`cd drv && npm run c-gate`, 39 scores byte-identical) and the engine
// against the slot stream in emulation (`npm run engine`, `npm run slots`).
// This SGDK glue has NOT been compiled or run on an emulator or hardware — no
// m68k toolchain lives in this repo. See drv/sgdk/README.md for the bring-up
// path.
#ifndef MMLISPDRV_H
#define MMLISPDRV_H

#include <genesis.h>

// ── Lifecycle ──────────────────────────────────────────────────────────────

// Upload the Z80 engine image, boot it, and wait (up to ~1 s) for it to report
// ready. Check MMLisp_isReady() afterwards: on a failed bring-up this returns
// with the engine dead rather than freezing the game. Call once at startup,
// before anything else here.
//
// There is no overlay blob any more — the engine is a single ~2.6 KB resident
// image. While MMLispDRV owns the Z80 you must not use SGDK's own sound drivers
// (XGM/PCM); this one writes the YM2612 and PSG directly.
void MMLisp_init(void);

// True once the engine is up and its protocol version matches this build.
bool MMLisp_isReady(void);

// Publish the PCM sample bank. A score with `def :sample` compiles to two
// blobs: the MMB and a `song.smp` sidecar holding the sample data, which rides
// its own 32 KB-aligned ROM bank (`BIN song_smp "song.smp" 32768`). Pass the
// rescomp symbol for it; the engine latches that bank around each frame's
// soft-mix. Call once after MMLisp_init (init clears Z80 RAM) and before
// starting a PCM track: with no bank published every PCM note is dropped and
// the song plays FM/PSG only — a failure that looks exactly like a missing
// track. Non-PCM scores need no call.
void MMLisp_setSampleBank(const u8* smp);

// Load a score. `mmb` points at the MMB blob in ROM — plain 68k memory now, so
// unlike the pre-split driver it needs NO alignment: only the sample bank still
// goes through the Z80's window. Loading resets all sequencer state and stops
// everything; one score is loaded at a time. Returns FALSE on a malformed blob.
bool MMLisp_loadScore(const u8* mmb);

// ── The per-frame hook (driver.md §6.6) ────────────────────────────────────

// Render slots into the ring. **Call this exactly once per vblank.** It tops
// the ring UP rather than rendering exactly one slot, so the lookahead is an
// invariant this call maintains and not something your game has to manage: an
// empty ring renders a full ring's worth, steady state renders one, and a frame
// you overran refills itself on the next call.
//
// It is self-limiting — called twice in a frame, the second call finds the ring
// full and does nothing — so calling it from both a vblank handler and a game
// loop is not a bug.
//
// Place it LAST in your frame, after the control calls below: they take effect
// on the next frame rendered, so rendering after them costs no extra latency.
// The call grabs the Z80 bus once, which stalls the mixer for the duration —
// pick a point in your frame where that is cheapest.
void MMLisp_frame(void);

// ── Track control (driver.md §6.5) ─────────────────────────────────────────
// Every call here takes effect on the next frame MMLisp_frame renders, so it is
// HEARD one ring-depth of frames later. That latency is why the default depth
// is shallow (§3.4).

// Start a track by its MMB track id (the id from the TRACK_TABLE — see the
// build output of drv/tools/mmb-build.mjs). Claiming a channel evicts its
// current owner and resets the channel's level state to defaults. Starting an
// already-running track restarts it from the top. Start each track of a score
// with its own call; unlike the pre-split mailbox there is no queue to overflow,
// so a score's whole start burst can go in one frame.
void MMLisp_startTrack(u8 track_id);

// Stop a track: key-off (the release tail runs out), free its channel, idle it.
void MMLisp_stopTrack(u8 track_id);

// Key-off one channel without stopping its track: releases a len=0 hold (the
// dispatcher resumes) or truncates a sounding note.
void MMLisp_keyOff(u8 channel_id);

// One-shot absolute parameter write on a channel, as if a PARAM_SET arrived in
// the stream. `target` is a target id (docs/opcodes.md §7); `value` is i8.
void MMLisp_setParam(u8 channel_id, u8 target_id, s8 value);

// Fade a track's volume to silence over `frames` frames, then stop it. Use for
// DJ-style scene transitions.
void MMLisp_fadeTrack(u8 track_id, u16 frames);

// Dynamic value slots (driver.md §6.4): one of 16 i16 slots the score reads via
// `$name` (PARAM_FROM_VAL / _ADD_VAL / _MUL_VAL). All arithmetic lives on the
// host — e.g. drive an FM3 AMS/FMS depth, or a live tempo. Post-split these are
// plain 68k memory, so a read is a read.
void MMLisp_setVal(u8 slot, s16 value);
s16 MMLisp_getVal(u8 slot);

// ── Status ─────────────────────────────────────────────────────────────────

// True while the track is running (dispatching or holding).
bool MMLisp_trackActive(u8 track_id);

// The engine's consumed-frame counter — the AUDIBLE clock. The sequencer runs
// ahead of it by the ring's fill level, so anything that has to line up with
// what the player hears compares against this, not against your own frame
// counter (driver.md §6.4).
u16 MMLisp_audibleFrame(void);

#endif // MMLISPDRV_H
