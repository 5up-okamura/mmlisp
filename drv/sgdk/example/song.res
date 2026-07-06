# SGDK resource script. The MMB blob must be 32 KB aligned because the Z80
# driver reads it from the bank-window base (see README §banking). rescomp's
# BIN `align` parameter (bytes, power of two) places it on that boundary.
#
# Produce song.mmb first:
#   node drv/tools/mmb-build.mjs path/to/mysong.mmlisp res/song.mmb
#
# BIN <name> <file> [align] [size_align] [compression]
BIN song_mmb "song.mmb" 32768
