/* Host harness for the §12.2 gate: read an MMB, render its slot stream, write
 * it to stdout as [u16 len][bytes] per frame.
 *
 * The point of keeping mmlispseq.c free of SGDK is exactly this — both sides of
 * the gate run on the host, so comparing the C against drv-player.js needs no
 * emulator and no assembler, and both are debuggable.
 *
 *   gate_main <song.mmb> [max_frames]
 */
#include <stdio.h>
#include <stdlib.h>

#include "mmlispseq.h"

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: gate_main <song.mmb> [max_frames]\n");
    return 2;
  }
  long max_frames = argc > 2 ? strtol(argv[2], NULL, 10) : 36000;

  FILE *f = fopen(argv[1], "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *mmb = malloc((size_t)len);
  if (fread(mmb, 1, (size_t)len, f) != (size_t)len) {
    fprintf(stderr, "short read\n");
    return 2;
  }
  fclose(f);

  static MMLSeq seq;
  int rc = mml_load(&seq, mmb, (uint32_t)len);
  if (rc) {
    fprintf(stderr, "mml_load failed: %d\n", rc);
    return 2;
  }
  mml_start_all(&seq);

  unsigned char slot[MML_SLOT_SIZE];
  for (long i = 0; i < max_frames; i++) {
    uint32_t n = mml_render_frame(&seq, slot);
    fputc((int)(n & 0xff), stdout);
    fputc((int)((n >> 8) & 0xff), stdout);
    fwrite(slot, 1, n, stdout);
    if (mml_done(&seq)) break;
  }
  /* Drain whatever the write cap held back, so the stream is complete — the
   * reference does the same at the end of captureSlotLog. */
  while (mml_pending(&seq)) {
    uint32_t n = mml_render_frame(&seq, slot);
    fputc((int)(n & 0xff), stdout);
    fputc((int)((n >> 8) & 0xff), stdout);
    fwrite(slot, 1, n, stdout);
  }
  fflush(stdout);
  if (seq.stopped) {
    fprintf(stderr, "undecoded opcode 0x%02x at frame %u\n", seq.stopped_op,
            (unsigned)seq.stopped_frame);
    return 3;
  }
  return 0;
}
