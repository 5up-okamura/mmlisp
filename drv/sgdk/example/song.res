# SGDK resource script for MMLispDRV.
#
# Produce the blobs first:
#   node drv/tools/mmb-build.mjs path/to/mysong.mmlisp res/song.mmb
# (or let the installer do it: node drv/tools/install-sgdk.mjs <proj> --song …)
#
# BIN <name> <file> [align] [size_align] [compression]
#
# The MMB needs NO alignment any more. Post-split the 68000 reads it straight
# out of its own address space (docs/driver.md §1.1); only the Z80's bank window
# ever needed a 32 KB boundary, and the score no longer goes through it.
BIN song_mmb "song.mmb" 2

# A PCM song also exports a sample bank sidecar (song.smp, mmb.md §10). That one
# DOES still ride the Z80's window — the mixer latches its bank every frame — so
# it keeps the 32 KB alignment. Leave the compression field unset: a compressed
# BIN is unpacked into RAM, and the window only reaches ROM.
#
# Uncomment when your score uses samples (rescomp fails on a BIN whose file is
# absent), and call MMLisp_setSampleBank(song_smp) — the BIN line alone leaves
# every PCM note dropped.
# BIN song_smp "song.smp" 32768
