/* Flat Mega Drive cartridge image: ROM from 0, work RAM at 0xFF0000.
 *
 * Built with the Debian/Ubuntu m68k-linux-gnu toolchain rather than SGDK's
 * m68k-elf one, because that is what an `apt-get install` provides and this ROM
 * has to build unattended. -ffreestanding -nostdlib makes the difference
 * irrelevant: nothing here links against a libc or a start file.
 */
OUTPUT_ARCH(m68k)
ENTRY(_start)

MEMORY
{
    rom (rx)  : ORIGIN = 0x00000000, LENGTH = 4M
    ram (rwx) : ORIGIN = 0x00FF0000, LENGTH = 64K - 512   /* the stack owns the top */
}

SECTIONS
{
    .vectors : { KEEP(*(.vectors)) } > rom
    .text : ALIGN(2) {
        *(.text .text.*)
        *(.rodata .rodata.*)
        . = ALIGN(2);
    } > rom
    /* The PCM bank rides the Z80's $8000 window, which banks in 32 KB steps,
       so MMLisp_setSampleBank's `(u32)smp >> 15` is only a bank number if the
       blob starts on one of those boundaries. rescomp does this with the `32768`
       field in song.res; here it is the linker's job. */
    .smp ALIGN(32768) : { KEEP(*(.smp)) } > rom

    _data_load = .;

    .data : AT (_data_load) ALIGN(2) {
        _data_start = .;
        *(.data .data.*)
        . = ALIGN(2);
        _data_end = .;
    } > ram

    .bss (NOLOAD) : ALIGN(2) {
        _bss_start = .;
        *(.bss .bss.*)
        *(COMMON)
        . = ALIGN(2);
        _bss_end = .;
    } > ram

    /DISCARD/ : { *(.comment) *(.note.*) *(.eh_frame) }
}
