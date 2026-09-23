/* Host harness for the §12.2 gate: read an MMB, render its slot stream, write
 * it to stdout as [u16 len][bytes] per frame.
 *
 * The point of keeping mmlispseq.c free of SGDK is exactly this — both sides of
 * the gate run on the host, so comparing the C against drv-player.js needs no
 * emulator and no assembler, and both are debuggable.
 *
 *   gate_main <song.mmb> [max_frames] [--cmds commands.txt] [--samples bank.smp]
 *                                    [--prime K] [--idle]
 *
 * commands.txt is one host command per line — "frame cmd a0 a1 a2" — applied at
 * the top of the matching frame, which is where the reference applies them too.
 * bank.smp is the SAMPLE_BANK a PCM score needs; it is a separate ROM bank on
 * the target, so it is a separate file here.
 *
 *
 * --idle starts nothing: every track waits for the command schedule, which is
 * how the SE gates fire START_TRACK / START_SE by hand (the reference's
 * autoStart: false).
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

static void emit_slot(const unsigned char *bytes, unsigned len) {
  fputc((int)(len & 0xff), stdout);
  fputc((int)((len >> 8) & 0xff), stdout);
  fwrite(bytes, 1, len, stdout);
}


int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: gate_main <song.mmb> [max_frames] [--cmds f] [--samples f]"
            " [--trig f] [--prime K] [--idle]\n");
    return 2;
  }
  long max_frames = argc > 2 && argv[2][0] != '-' ? strtol(argv[2], NULL, 10) : 36000;
  const char *cmd_path = 0, *smp_path = 0, *trig_path = 0;
  int idle = 0;
  long prime = -1; /* --prime K: the SGDK host's load (see below) */
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--cmds") && i + 1 < argc) cmd_path = argv[++i];
    else if (!strcmp(argv[i], "--samples") && i + 1 < argc) smp_path = argv[++i];
    else if (!strcmp(argv[i], "--trig") && i + 1 < argc) trig_path = argv[++i];
    else if (!strcmp(argv[i], "--prime") && i + 1 < argc)
      prime = strtol(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--idle")) idle = 1;
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
    /* rom_base 0 — the reference models the bank at ROM address 0 too, so the
     * absolute {bank, offset} in every PCM_START matches byte for byte. */
    if (mml_load_samples(&seq, smp, (uint32_t)slen, 0)) {
      fprintf(stderr, "bad sample bank\n");
      return 2;
    }
  }
  /* --trig: one byte per track per RENDERED frame, in track order — the trig
   * status bytes (opcodes.md 0x42). The drain frames at the end are not
   * rendered and carry none, which is where the reference stops logging too. */
  FILE *trig_f = 0;
  if (trig_path) {
    trig_f = fopen(trig_path, "wb");
    if (!trig_f) {
      fprintf(stderr, "cannot write %s\n", trig_path);
      return 2;
    }
  }
#define EMIT_TRIG()                                                            \
  do {                                                                         \
    if (trig_f)                                                                \
      for (uint8_t t_ = 0; t_ < seq.track_count; t_++)                         \
        fputc(seq.trk[t_].trig_byte, trig_f);                                  \
  } while (0)

  unsigned char slot[MML_SLOT_SIZE];
  if (prime >= 0) {
    /* The SGDK host's load: nothing started, PRIME, K idle frames, then
     * START_TRACK for every track in order — the reference's
     * captureSlotLog({ prime: K }) does the same. */
    mml_prime_tracks(&seq);
    for (long k = 0; k < prime; k++) {
      uint32_t n = mml_render_frame(&seq, slot);
      emit_slot(slot, n);
      EMIT_TRIG();
    }
    for (uint8_t i = 0; i < mml_track_count(&seq); i++) mml_start_track(&seq, mml_track_id(&seq, i));
  } else if (!idle) {
    mml_start_all(&seq);
  }

  for (long i = 0; i < max_frames; i++) {
    for (int c = 0; c < ncmds; c++)
      if (cmds[c].frame == i)
        mml_command(&seq, (uint8_t)cmds[c].cmd, (uint8_t)cmds[c].a0,
                    (uint8_t)cmds[c].a1, (uint8_t)cmds[c].a2);
    uint32_t n = mml_render_frame(&seq, slot);
    emit_slot(slot, n);
    EMIT_TRIG();
    if (mml_done(&seq)) break;
  }
  /* Drain whatever the write cap held back, so the stream is complete — the
   * reference does the same at the end of captureSlotLog. These slots close
   * without running a frame: the song is over, and rendering one more would
   * invent traffic the reference never produces. */
  while (mml_pending(&seq)) {
    uint32_t n = mml_drain_frame(&seq, slot);
    emit_slot(slot, n);
  }
  fflush(stdout);
  if (trig_f) fclose(trig_f);
  if (seq.stopped) {
    fprintf(stderr, "undecoded opcode 0x%02x at frame %u\n", seq.stopped_op,
            (unsigned)seq.stopped_frame);
    return 3;
  }
  return 0;
}
