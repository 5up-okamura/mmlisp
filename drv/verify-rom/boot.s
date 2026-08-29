| Mega Drive boot: vector table, cartridge header, and the little that has to
| happen before C can run. See README.md in this directory for why the ROM
| exists at all.
|
| This is NOT a replacement for SGDK. It is the smallest thing that boots a
| 68000, brings up the VDP, takes a vertical interrupt and calls main() — so
| that mmlispseq.c and mmlispdrv.c, which are the actual subjects, run on the
| emulated machine with nothing of ours between them and it.

    .section .vectors, "a"
    .align 2

    .long   0x00FFFE00          | 0  initial supervisor stack
    .long   _start              | 1  reset
    .long   _bus_error, _bus_error                        | 2-3  bus error / address error
    .long   _except, _except, _except                     | 4-6  illegal/div0/chk
    .long   _except, _except, _except                     | 7-9  trapv/priv/trace
    .long   _except, _except                              | 10-11 line A / line F
    .long   _except, _except, _except, _except            | 12-15 reserved
    .long   _except, _except, _except, _except            | 16-19
    .long   _except, _except, _except, _except            | 20-23
    .long   _except                                       | 24 spurious
    .long   _except                                       | 25 level 1
    .long   _int_ext                                      | 26 level 2 — external
    .long   _except                                       | 27 level 3
    .long   _int_h                                        | 28 level 4 — horizontal
    .long   _except                                       | 29 level 5
    .long   _int_v                                        | 30 level 6 — VERTICAL
    .long   _except                                       | 31 level 7
    .long   _except, _except, _except, _except            | 32-35 traps
    .long   _except, _except, _except, _except            | 36-39
    .long   _except, _except, _except, _except            | 40-43
    .long   _except, _except, _except, _except            | 44-47
    .long   _except, _except, _except, _except            | 48-51
    .long   _except, _except, _except, _except            | 52-55
    .long   _except, _except, _except, _except            | 56-59
    .long   _except, _except, _except, _except            | 60-63

| ── Cartridge header ───────────────────────────────────────────────────────
| BlastEm identifies a Genesis image by "SEGA" at 0x100 (system.c,
| detect_system_type). Everything after that is convention, but a header that
| only satisfies the detector is a header that will confuse the next reader.
    .ascii  "SEGA MEGA DRIVE "
    .ascii  "MMLISP  2026.AUG"
    .ascii  "MMLispDRV DAC probe                             "
    .ascii  "MMLispDRV DAC probe                             "
    .ascii  "GM MMLISP-00"
    .word   0x0000                          | checksum: unchecked by the emulator
    .ascii  "J               "              | control data
    .long   0x00000000                      | ROM start
    .long   0x000FFFFF                      | ROM end
    .long   0x00FF0000                      | RAM start
    .long   0x00FFFFFF                      | RAM end
    .ascii  "            "                  | no SRAM
    .ascii  "                                        "
    .ascii  "JUE             "              | region

| ── Entry ─────────────────────────────────────────────────────────────────
    .text
    .global _start
_start:
    move.w  #0x2700, %sr                    | interrupts off until we are ready

    | TMSS. A Mega Drive with a TMSS ROM locks the VDP until the string is
    | written; a Model 1 without one has no register here at all, so the version
    | check gates it.
    move.b  0x00A10001, %d0
    andi.b  #0x0F, %d0
    beq.s   1f
    move.l  #0x53454741, 0x00A14000         | 'SEGA'
1:
    | Take the Z80 bus and hold it in reset while we set the VDP up, so nothing
    | it does can race the bring-up. MMLisp_init() takes it from here.
    move.w  #0x0100, 0x00A11100             | BUSREQ
    move.w  #0x0100, 0x00A11200             | reset off (Z80 stopped, not reset)

    | VDP registers. Display ON with an empty screen, which matters: the VDP
    | steals 68000 bus cycles during active display, and the Z80's sample fetch
    | through the $8000 window rides that same bus. A blanked run would be a
    | quieter machine than the one we are trying to characterise.
    lea     0x00C00004, %a0
    lea     vdp_init(%pc), %a1
    moveq   #19-1, %d0
    move.w  #0x8000, %d1
2:  move.b  (%a1)+, %d1
    move.w  %d1, (%a0)
    addi.w  #0x0100, %d1
    andi.w  #0xFF00, %d1
    dbra    %d0, 2b

    | Clear VRAM (0x10000 bytes) — an uninitialised plane map draws garbage
    | tiles, and garbage tiles are sprite/plane fetches the VDP has to make.
    move.l  #0x40000000, (%a0)              | VRAM write, address 0
    lea     0x00C00000, %a1
    move.w  #0x8000-1, %d0
3:  move.w  #0, (%a1)
    dbra    %d0, 3b

    | .bss
    lea     _bss_start, %a0
    lea     _bss_end, %a1
4:  cmpa.l  %a1, %a0
    bge.s   5f
    clr.b   (%a0)+
    bra.s   4b
5:
    | .data, from its ROM image into RAM
    lea     _data_load, %a0
    lea     _data_start, %a1
    lea     _data_end, %a2
6:  cmpa.l  %a2, %a1
    bge.s   7f
    move.b  (%a0)+, (%a1)+
    bra.s   6b
7:
    move.w  #0x2000, %sr                    | interrupts on (level 6 gets through)
    jsr     main
8:  bra.s   8b

| ── Interrupts ────────────────────────────────────────────────────────────
| The vertical interrupt is the machine's own clock and the only one this
| program needs. It does nothing but count: the frame's work belongs to the
| main loop, exactly as it does under SGDK, so that what is being measured is
| the same shape of program the user runs.
    .global _int_v
_int_v:
    addq.l  #1, vtimer
    rte

_int_h:
_int_ext:
    rte

| An exception parks the machine, but not silently: it records WHAT happened in
| the probe mailbox first (verify-rom/probe.h, PROBE_OFF_FAULT). Without this a
| crash and a hang look identical from outside — both are "the counters stopped"
| — and they have nothing in common as bugs.
|
| The offsets are the ones probe.h asserts, so a field reordered there is a
| compile error and not a wrong number here.
_except:
    move.w  #0x2700, %sr
    lea     probe, %a0
    move.w  #0xDEAD, 4(%a0)         | PROBE_FAULT_EXCEPT
    move.w  2(%sp), 6(%a0)          | stacked PC, high word
    move.w  4(%sp), 8(%a0)          | stacked PC, low word
    move.w  2(%sp), 10(%a0)
    move.w  4(%sp), 12(%a0)
9:  bra.s   9b

| Bus and address errors (vectors 2 and 3) push a different, longer frame: the
| ACCESS ADDRESS is at 2(sp), and it is far more useful than the PC — an odd
| address here names the pointer that was wrong.
_bus_error:
    move.w  #0x2700, %sr
    lea     probe, %a0
    move.w  #0xBADD, 4(%a0)         | PROBE_FAULT_ADDRESS
    move.w  2(%sp), 6(%a0)          | access address, high word
    move.w  4(%sp), 8(%a0)          | access address, low word
    move.w  10(%sp), 10(%a0)        | and the PC of the instruction that did it
    move.w  12(%sp), 12(%a0)
10: bra.s   10b

    .section .rodata
vdp_init:
    .byte   0x04            | 00 no H-int, no HV latch
    .byte   0x74            | 01 display on, V-int on, DMA on, V28, MD mode
    .byte   0x30            | 02 plane A  @ 0xC000
    .byte   0x3C            | 03 window   @ 0xF000
    .byte   0x07            | 04 plane B  @ 0xE000
    .byte   0x6C            | 05 sprites  @ 0xD800
    .byte   0x00            | 06
    .byte   0x00            | 07 backdrop colour 0
    .byte   0x00            | 08
    .byte   0x00            | 09
    .byte   0xFF            | 0A H-int counter (never)
    .byte   0x00            | 0B full scroll, no external int
    .byte   0x81            | 0C H40, no interlace
    .byte   0x3F            | 0D h-scroll  @ 0xFC00
    .byte   0x00            | 0E
    .byte   0x02            | 0F auto-increment 2
    .byte   0x01            | 10 scroll size 64x32
    .byte   0x00            | 11 window H
    .byte   0x00            | 12 window V
    .align 2
