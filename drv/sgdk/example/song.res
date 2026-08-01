# SGDK resource script. Both blobs the Z80 reads through its bank window must be
# 32 KB aligned, because the driver addresses them from the window base (see
# README §banking). rescomp's BIN `align` parameter (bytes, power of two) places
# them on that boundary. Leave the compression field unset: a compressed BIN is
# unpacked into RAM, and the Z80's bank window only reaches ROM.
#
# Produce song.mmb first, and copy the overlay blob next to this file:
#   node drv/tools/mmb-build.mjs path/to/mysong.mmlisp res/song.mmb
#   cp drv/sgdk/mmlispdrv_ovl.bin res/
#
# BIN <name> <file> [align] [size_align] [compression]
BIN song_mmb   "song.mmb"          32768
BIN mmlisp_ovl "mmlispdrv_ovl.bin" 32768

# A PCM song also exports a sample bank sidecar (song.smp, mmb.md §10) — it
# rides its own bank, so it needs the same alignment. Uncomment it when your
# score uses samples (rescomp fails on a BIN whose file is absent), and call
# MMLisp_setSampleBank(song_smp) after MMLisp_init.
# BIN song_smp "song.smp" 32768
