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
 *   pairs_main <slots.bin> <fifo> <fifo_pairs> <ppg> <lut_page> <op_stride> <op_port>
 *              <voices> <idle_after_gen> [lead] [pumps]
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
/* The engine's advance between two grabs: 17 pairs at two grabs a frame, 34 at
 * one; every seventh grab is late by 24 more — past the head it planned for. */
static unsigned advance = 17;

static void grab(MMLPairs *p, uint16_t release, unsigned *consumer, uint8_t *fifo_lo, const MMLPairsCfg *cfg, unsigned *ngrab) {
  uint8_t ops[8], vals[8], out[2 * 8];
  uint16_t dst = 0;
  uint8_t prev = *fifo_lo;
  uint16_t nb = (uint16_t)(2 * mmlp_plan(p, prev, release, ops, vals, &dst));
  for (uint16_t k = 0; 2 * k < nb; k++) { out[2 * k] = ops[k]; out[2 * k + 1] = vals[k]; }
  *consumer = (*consumer + ((*ngrab)++ % 7 == 6 ? advance + 24 : advance)) % cfg->fifo_pairs;
  *fifo_lo = (uint8_t)(2 * *consumer);
  if (nb && !mmlp_in_time(prev, dst, *fifo_lo)) { mmlp_abort(p); nb = 0; fputc('L', stdout); }
  fputc('G', stdout);
  fputc(dst & 0xff, stdout); fputc(dst >> 8, stdout);
  fputc(nb, stdout);
  fwrite(out, 1, nb, stdout);
  uint8_t psg[256];
  uint16_t np = mmlp_psg_take(p, release, psg, sizeof psg);
  fputc('P', stdout);
  fputc(np & 0xff, stdout);
  fwrite(psg, 1, np, stdout);
}

int main(int argc, char **argv) {
  if (argc < 10) { fprintf(stderr, "usage: see the header comment\n"); return 2; }  /* argv[10]: lead, optional */
  long len = 0;
  unsigned char *slots = slurp(argv[1], &len);
  if (!slots) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }
  MMLPairsCfg cfg;
  memset(&cfg, 0, sizeof cfg);
  cfg.fifo = (uint16_t)strtol(argv[2], 0, 0);
  cfg.fifo_pairs = (uint8_t)strtol(argv[3], 0, 0);
  cfg.pairs_per_grab = (uint8_t)strtol(argv[4], 0, 0);
  cfg.lut_page = (uint8_t)strtol(argv[5], 0, 0);
  cfg.op_stride = (uint8_t)strtol(argv[6], 0, 0);
  cfg.op_port = (uint8_t)strtol(argv[7], 0, 0);
  cfg.voices = (uint8_t)strtol(argv[8], 0, 0);
  cfg.idle_after_gen = (uint8_t)strtol(argv[9], 0, 0);
  /* argv[11], optional: grabs a frame, 2 (the default) or 1 (VBlank-only). */
  const int pumps = argc > 11 ? atoi(argv[11]) : 2;
  if (pumps == 1) { advance = 34; cfg.ahead = MMLP_AHEAD_ONE; }
  static MMLPairs p;
  mmlp_init(&p, &cfg);
  /* The modelled engine: its next-pair index, as the byte it would publish. */
  unsigned consumer = 0, ngrab = 0;
  uint8_t fifo_lo = 0xff;
  long i = 0;
  /* argv[10], optional: the render lead. Absent, every slot is sent as soon as
   * it is queued (release = frames queued). Given, slots are queued `lead` frames ahead of
   * their release, and each frame's two grabs pass the frame count — the SGDK
   * host's schedule (mmlispdrv.c MMLisp_frame). */
  const int lead = argc > 10 ? atoi(argv[10]) : -1;
  uint16_t release = 0;
  for (;;) {
    int more = i + 2 <= len;
    if (lead < 0) {
      if (!more) break;
    } else {
      /* queue up to `lead` frames past the ones whose time has come */
      while (more && (int16_t)(p.frames_in - (uint16_t)(release + lead)) < 0) {
        unsigned n = slots[i] | (slots[i + 1] << 8);
        i += 2;
        if (i + (long)n > len) { more = 0; break; }
        mmlp_slot(&p, slots + i, (uint16_t)n);
        i += n;
        more = i + 2 <= len;
      }
      release++;
      for (int g = 0; g < pumps; g++) grab(&p, release, &consumer, &fifo_lo, &cfg, &ngrab);
      if (!more && (int16_t)(release - p.frames_in) >= 0) break;
      continue;
    }
    unsigned n = slots[i] | (slots[i + 1] << 8);
    i += 2;
    if (i + (long)n > len) break;
    mmlp_slot(&p, slots + i, (uint16_t)n);
    i += n;
    for (int g = 0; g < pumps; g++) grab(&p, p.frames_in, &consumer, &fifo_lo, &cfg, &ngrab);
  }
  /* Drain: more grabs with no new slots, until the queue is empty. */
  for (int g = 0; g < 4096 && mmlp_pending(&p); g++) grab(&p, p.frames_in, &consumer, &fifo_lo, &cfg, &ngrab);
  fprintf(stderr, "pairs: %u late, ", p.late);
  fprintf(stderr, "pairs: %u grabs, %u pairs, %u faults, overflow %u\n",
          p.grabs, p.pairs_written, p.fault, p.overflow);
  return 0;
}
