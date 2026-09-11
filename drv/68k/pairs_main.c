/* Host harness for the pairs gate (tools/pairs-gate.mjs): read the slot
 * stream gate_main emits ([u16 len][bytes] per frame) from a file, run every
 * slot through mmlpairs, and drive the planner with a modelled consumer — two
 * grabs a frame, the engine's index advancing by 17 pairs a grab — writing
 * what the 68000 would have put on the wire:
 *
 *   for each grab:  [u8 'G'][u16 dst][u8 n][n bytes]  the pair bytes
 *                   [u8 'P'][u8 n][n bytes]            the PSG bytes released
 *
 * The JS twin (tools/pairs-model.mjs) produces the same stream from the same
 * slots, and the gate compares the two byte for byte.
 *
 *   pairs_main <slots.bin> <fifo> <fifo_pairs> <ppg> <lut_page> <levels> <op_limit>
 *              <idle> <level> <master> <src_lo> <src_hi> <end_lo> <end_hi> <step> <start> <stop> <port>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mmlpairs.h"

static unsigned char *slurp(const char *path, long *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *buf = malloc((size_t)len);
  if (!buf || fread(buf, 1, (size_t)len, f) != (size_t)len) { fclose(f); free(buf); return 0; }
  fclose(f);
  *out_len = len;
  return buf;
}

/* One grab as the host makes it: plan from the index read last time, then the
 * modelled engine moves on and the grab reads the fresh index; a late grab
 * (every seventh one here, as if a pump had been skipped) copies nothing and
 * gives its pairs back. The JS twin (tools/pairs-gate.mjs) does the same. */
static void grab(MMLPairs *p, unsigned *consumer, uint8_t *fifo_lo, const MMLPairsCfg *cfg, unsigned *ngrab) {
  uint8_t out[2 * 8];
  uint16_t dst = 0;
  uint8_t prev = *fifo_lo;
  uint16_t nb = mmlp_plan(p, prev, out, &dst);
  *consumer = (*consumer + ((*ngrab)++ % 7 == 6 ? 41 : 17)) % cfg->fifo_pairs;
  *fifo_lo = (uint8_t)(2 * *consumer);
  if (nb && !mmlp_in_time(prev, dst, *fifo_lo)) { mmlp_abort(p); nb = 0; fputc('L', stdout); }
  fputc('G', stdout);
  fputc(dst & 0xff, stdout); fputc(dst >> 8, stdout);
  fputc(nb, stdout);
  fwrite(out, 1, nb, stdout);
  uint8_t psg[256];
  uint16_t np = mmlp_psg_take(p, psg, sizeof psg);
  fputc('P', stdout);
  fputc(np & 0xff, stdout);
  fwrite(psg, 1, np, stdout);
}

int main(int argc, char **argv) {
  if (argc < 19) { fprintf(stderr, "usage: see the header comment\n"); return 2; }
  long len = 0;
  unsigned char *slots = slurp(argv[1], &len);
  if (!slots) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }
  MMLPairsCfg cfg;
  cfg.fifo = (uint16_t)strtol(argv[2], 0, 0);
  cfg.fifo_pairs = (uint8_t)strtol(argv[3], 0, 0);
  cfg.pairs_per_grab = (uint8_t)strtol(argv[4], 0, 0);
  cfg.lut_page = (uint8_t)strtol(argv[5], 0, 0);
  cfg.levels = (uint8_t)strtol(argv[6], 0, 0);
  cfg.op_limit = (uint8_t)strtol(argv[7], 0, 0);
  cfg.op_idle = (uint8_t)strtol(argv[8], 0, 0);
  cfg.op_level = (uint8_t)strtol(argv[9], 0, 0);
  cfg.op_master = (uint8_t)strtol(argv[10], 0, 0);
  cfg.op_src_lo = (uint8_t)strtol(argv[11], 0, 0);
  cfg.op_src_hi = (uint8_t)strtol(argv[12], 0, 0);
  cfg.op_end_lo = (uint8_t)strtol(argv[13], 0, 0);
  cfg.op_end_hi = (uint8_t)strtol(argv[14], 0, 0);
  cfg.op_step = (uint8_t)strtol(argv[15], 0, 0);
  cfg.op_start = (uint8_t)strtol(argv[16], 0, 0);
  cfg.op_stop = (uint8_t)strtol(argv[17], 0, 0);
  cfg.op_port = (uint8_t)strtol(argv[18], 0, 0);
  static MMLPairs p;
  mmlp_init(&p, &cfg);
  /* The modelled engine: its next-pair index, as the byte it would publish. */
  unsigned consumer = 0, ngrab = 0;
  uint8_t fifo_lo = 0xff;
  long i = 0;
  while (i + 2 <= len) {
    unsigned n = slots[i] | (slots[i + 1] << 8);
    i += 2;
    if (i + (long)n > len) break;
    mmlp_slot(&p, slots + i, (uint16_t)n);
    i += n;
    for (int g = 0; g < 2; g++) grab(&p, &consumer, &fifo_lo, &cfg, &ngrab);
  }
  /* Drain: more grabs with no new slots, until the queue is empty. */
  for (int g = 0; g < 4096 && mmlp_pending(&p); g++) grab(&p, &consumer, &fifo_lo, &cfg, &ngrab);
  fprintf(stderr, "pairs: %u late, ", p.late);
  fprintf(stderr, "pairs: %u grabs, %u pairs, dropped voice %u loop %u, step rounded %u, overflow %u\n",
          p.grabs, p.pairs_written, p.dropped_voice, p.dropped_loop, p.step_rounded, p.overflow);
  return 0;
}
