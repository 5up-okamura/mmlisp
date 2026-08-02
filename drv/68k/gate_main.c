/* Host harness for the §12.2 gate: read an MMB, render its slot stream, write
 * it to stdout as [u16 len][bytes] per frame.
 *
 * The point of keeping mmlispseq.c free of SGDK is exactly this — both sides of
 * the gate run on the host, so comparing the C against drv-player.js needs no
 * emulator and no assembler, and both are debuggable.
 *
 *   gate_main <song.mmb> [max_frames] [--cmds commands.txt] [--samples bank.smp]
 *
 * commands.txt is one host command per line — "frame cmd a0 a1 a2" — applied at
 * the top of the matching frame, which is where the reference applies them too.
 * bank.smp is the SAMPLE_BANK a PCM score needs; it is a separate ROM bank on
 * the target, so it is a separate file here.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mmlispseq.h"

static unsigned char *slurp(const char *path, long *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *buf = malloc((size_t)len);
  if (!buf || fread(buf, 1, (size_t)len, f) != (size_t)len) {
    fclose(f);
    free(buf);
    return 0;
  }
  fclose(f);
  *out_len = len;
  return buf;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: gate_main <song.mmb> [max_frames] [--cmds f] [--samples f]\n");
    return 2;
  }
  long max_frames = argc > 2 && argv[2][0] != '-' ? strtol(argv[2], NULL, 10) : 36000;
  const char *cmd_path = 0, *smp_path = 0;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--cmds") && i + 1 < argc) cmd_path = argv[++i];
    else if (!strcmp(argv[i], "--samples") && i + 1 < argc) smp_path = argv[++i];
  }

  /* Host command schedule (KEY_OFF / SET_PARAM / FADE_TRACK / SET_VAL). */
  enum { MAX_CMDS = 256 };
  static struct { long frame; int cmd, a0, a1, a2; } cmds[MAX_CMDS];
  int ncmds = 0;
  if (cmd_path) {
    FILE *cf = fopen(cmd_path, "r");
    if (!cf) {
      fprintf(stderr, "cannot open %s\n", cmd_path);
      return 2;
    }
    while (ncmds < MAX_CMDS &&
           fscanf(cf, "%ld %d %d %d %d", &cmds[ncmds].frame, &cmds[ncmds].cmd,
                  &cmds[ncmds].a0, &cmds[ncmds].a1, &cmds[ncmds].a2) == 5)
      ncmds++;
    fclose(cf);
  }

  long len = 0;
  unsigned char *mmb = slurp(argv[1], &len);
  if (!mmb) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }

  static MMLSeq seq;
  int rc = mml_load(&seq, mmb, (uint32_t)len);
  if (rc) {
    fprintf(stderr, "mml_load failed: %d\n", rc);
    return 2;
  }
  if (smp_path) {
    long slen = 0;
    unsigned char *smp = slurp(smp_path, &slen);
    if (!smp) {
      fprintf(stderr, "cannot read %s\n", smp_path);
      return 2;
    }
    if (mml_load_samples(&seq, smp, (uint32_t)slen)) {
      fprintf(stderr, "bad sample bank\n");
      return 2;
    }
  }
  mml_start_all(&seq);

  unsigned char slot[MML_SLOT_SIZE];
  for (long i = 0; i < max_frames; i++) {
    for (int c = 0; c < ncmds; c++)
      if (cmds[c].frame == i)
        mml_command(&seq, (uint8_t)cmds[c].cmd, (uint8_t)cmds[c].a0,
                    (uint8_t)cmds[c].a1, (uint8_t)cmds[c].a2);
    uint32_t n = mml_render_frame(&seq, slot);
    fputc((int)(n & 0xff), stdout);
    fputc((int)((n >> 8) & 0xff), stdout);
    fwrite(slot, 1, n, stdout);
    if (mml_done(&seq)) break;
  }
  /* Drain whatever the write cap held back, so the stream is complete — the
   * reference does the same at the end of captureSlotLog. These slots close
   * without running a frame: the song is over, and rendering one more would
   * invent traffic the reference never produces. */
  while (mml_pending(&seq)) {
    uint32_t n = mml_drain_frame(&seq, slot);
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
