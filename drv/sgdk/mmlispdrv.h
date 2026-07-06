// MMLispDRV — SGDK (Sega Genesis Dev Kit) host API.
//
// The 68000 side of the driver: load the Z80 image, then start/stop tracks
// through the mailbox (docs/driver.md §6). The Z80 plays autonomously off its
// own 60 Hz vblank interrupt — after starting tracks the 68k does nothing per
// frame.
//
// STATUS: the Z80 driver's register output is verified against the JS
// reference in emulation (drv/tools/verify.mjs). This C glue is written
// against the SGDK ~1.6x Z80 API but has NOT yet been compiled or run on an
// emulator/hardware. Treat it as a starting point; see drv/sgdk/README.md for
// the on-target verification path.
#ifndef MMLISPDRV_H
#define MMLISPDRV_H

#include <genesis.h>

// Upload the Z80 image and spin until the driver's main loop reports ready
// (mailbox driver_ready == 0xD2). Call once at startup, before any track ops.
// While MMLispDRV owns the Z80 you must not use SGDK's own sound drivers
// (XGM/PCM); this driver writes the YM2612 and PSG directly.
void MMLisp_init(void);

// True once the Z80 driver is up. MMLisp_init already waits for this; use it
// for a non-blocking readiness check.
bool MMLisp_isReady(void);

// Start a track by its MMB track id (the id from the TRACK_TABLE; see the
// build output of drv/tools/mmb-build.mjs). `mmb` points at the MMB blob in
// ROM and MUST be aligned to a 32 KB boundary — the driver reads the file from
// the Z80 bank window base (docs constraint; see README). Starting an already
// active track restarts it from the top. Start each track of a score with its
// own call.
void MMLisp_startTrack(const u8* mmb, u8 track_id);

// Stop a track: key-off (release tail runs out), free its channel, mark idle.
void MMLisp_stopTrack(u8 track_id);

// Read a per-track mailbox status byte (0..15): bit7 active, bit6 fading,
// bits5-0 the last MARKER id the track passed (host sync point).
u8 MMLisp_trackStatus(u8 track_index);

#endif // MMLISPDRV_H
