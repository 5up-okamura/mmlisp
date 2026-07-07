// MMLispDRV — SGDK host implementation. See mmlispdrv.h for the API and the
// verification-status caveat.
#include "mmlispdrv.h"
#include "mmlispdrv_bin.h"   // generated: mmlispdrv_bin[], MMLISPDRV_SIZE

// ── Z80 address space, as seen from the 68000 (Z80 RAM is at 0xA00000) ──────
#define Z80_RAM(off)   ((vu8*)(0xA00000 + (off)))

// Mailbox layout (docs/driver.md §6.1), Z80-RAM offsets. The mailbox tracks
// the driver's DATA_BASE, which moves as the image grows; it is still the only
// published address the host needs.
#define MB_RING        0x18F0   // 8 cells x 4 bytes {cmd, a0, a1, a2}
#define MB_HEAD        0x1910   // 68k-owned: next cell to write
#define MB_TAIL        0x1911   // Z80-owned: next cell to read
#define MB_TSTAT       0x1912   // 16 per-track status bytes
#define MB_READY       0x1922   // 0xD2 when the driver main loop is up
#define G_OVL_BANK     0x1924   // overlay ROM bank (host sets at init; driver.md §5)
#define VAL_SLOTS      0x1930   // 16 x i16 dynamic value slots (68k read/write)

// Command ids (docs/opcodes.md / driver.md §6.2).
#define CMD_START_TRACK  0x01
#define CMD_STOP_TRACK   0x02
#define CMD_KEY_OFF      0x03
#define CMD_SET_PARAM    0x04
#define CMD_FADE_TRACK   0x05
#define CMD_SET_VAL      0x06

// Post one command into the mailbox ring. The 68k requests the Z80 bus (which
// halts the Z80), so the access is fully serialized; we still write the cmd
// byte last to honor the ring discipline. Drops the command if the ring is
// full (8 pending) — with per-frame draining that never happens in practice.
static void mailbox_send(u8 cmd, u8 a0, u8 a1, u8 a2)
{
    Z80_requestBus(TRUE);

    u8 head = *Z80_RAM(MB_HEAD);
    u8 tail = *Z80_RAM(MB_TAIL);
    u8 next = (head + 1) & 7;
    if (next != tail)
    {
        u16 cell = MB_RING + (head << 2);
        *Z80_RAM(cell + 1) = a0;
        *Z80_RAM(cell + 2) = a1;
        *Z80_RAM(cell + 3) = a2;
        *Z80_RAM(cell + 0) = cmd;      // cmd byte last
        *Z80_RAM(MB_HEAD)  = next;
    }

    Z80_releaseBus();
}

void MMLisp_init(const u8* overlay_rom)
{
    // The boot code itself now lives in an overlay (ovl_boot, driver.md §5.3), so
    // the Z80 needs the overlay ROM bank in RAM (G_OVL_BANK) BEFORE it runs its
    // reset vector — the reset stub loads ovl_boot with it, and ovl_boot's RAM
    // clear preserves it. So upload the resident image AND publish the bank while
    // the Z80 is held in reset, then release. This mirrors the trace harness
    // (run-trace.mjs). The overlay blob must be 32 KB-aligned in ROM so its bank
    // window base is overlay byte 0.
    //
    // (SGDK bus/reset symbols vary across versions; adjust to your SGDK. The
    // invariant is: G_OVL_BANK is written before the Z80 executes address 0.)
    Z80_init();
    Z80_requestBus(TRUE);
    Z80_startReset();

    // Byte-wise upload — Z80 RAM at 0xA00000 is 8-bit; a 16-bit write corrupts
    // the odd byte.
    {
        const u8* src = mmlispdrv_bin;
        vu8* dst = (vu8*)0xA00000;
        for (u16 i = 0; i < MMLISPDRV_SIZE; i++)
            dst[i] = src[i];
    }

    u16 bank = (u16)((u32)overlay_rom >> 15);
    *Z80_RAM(G_OVL_BANK)     = bank & 0xFF;
    *Z80_RAM(G_OVL_BANK + 1) = (bank >> 8) & 0xFF;

    Z80_endReset();     // release reset → boots at PC=0 with G_OVL_BANK already set
    Z80_releaseBus();

    while (!MMLisp_isReady())
        ;
}

bool MMLisp_isReady(void)
{
    Z80_requestBus(TRUE);
    u8 ready = *Z80_RAM(MB_READY);
    Z80_releaseBus();
    return ready == 0xD2;
}

void MMLisp_startTrack(const u8* mmb, u8 track_id)
{
    // The bank register selects which 32 KB page of the 68k address space maps
    // to the Z80 window at 0x8000. The driver reads the MMB from the window
    // base, so the blob must sit on a 32 KB boundary; bank = address >> 15.
    u32 addr = (u32)mmb;
    u16 bank = addr >> 15;
    mailbox_send(CMD_START_TRACK, track_id, bank & 0xFF, (bank >> 8) & 0xFF);
}

void MMLisp_stopTrack(u8 track_id)
{
    mailbox_send(CMD_STOP_TRACK, track_id, 0, 0);
}

void MMLisp_keyOff(u8 channel_id)
{
    mailbox_send(CMD_KEY_OFF, channel_id, 0, 0);
}

void MMLisp_setParam(u8 channel_id, u8 target_id, s8 value)
{
    mailbox_send(CMD_SET_PARAM, channel_id, target_id, (u8)value);
}

void MMLisp_fadeTrack(u8 track_id, u8 frames)
{
    mailbox_send(CMD_FADE_TRACK, track_id, frames, 0);
}

void MMLisp_setVal(u8 slot, s16 value)
{
    // The score reads the slot via PARAM_FROM_VAL / _ADD_VAL / _MUL_VAL at
    // dispatch time (driver.md §6.4). Interactive control: e.g. a filter-depth
    // slider, game-state-driven timbre, live tempo.
    mailbox_send(CMD_SET_VAL, slot, value & 0xFF, (value >> 8) & 0xFF);
}

s16 MMLisp_getVal(u8 slot)
{
    // GET_VAL is a direct read of the published val-slot array — no round-trip.
    Z80_requestBus(TRUE);
    vu8* p = Z80_RAM(VAL_SLOTS + ((slot & 0x0F) << 1));
    s16 v = (s16)(p[0] | (p[1] << 8));
    Z80_releaseBus();
    return v;
}

u8 MMLisp_trackStatus(u8 track_index)
{
    Z80_requestBus(TRUE);
    u8 s = *Z80_RAM(MB_TSTAT + (track_index & 0x0F));
    Z80_releaseBus();
    return s;
}
