/* Host harness for the pairs gate's VIEW check (tools/pairs-gate.mjs): the
 * SGDK host takes each frame into the converter straight from the sequencer
 * (mmlp_render: no slot is packed or parsed); the rest of the gates follow the
 * slot path (mml_render_frame + mmlp_slot), which c-gate and pairs-gate hold to
 * the JS reference. Here the same score runs down both paths side by side —
 * two sequencers, two converters — and after every frame the two converters
 * must be byte for byte the same, and so must the two sequencers.
 *
 *   view_main <song.mmb> <frames> [--samples bank.smp] [--prime K]
 *             <fifo> <fifo_pairs> <ppg> <lut_page> <op_stride> <op_port> <voices> <idle_after_gen>
 *
 * Prints "ok <frames>" or the first frame the two differ at, and exits 1. */
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

static MMLSeq seq_a, seq_b;
static MMLPairs pairs_a, pairs_b;

static int same(long frame, const char *what) {
  if (memcmp(&pairs_a, &pairs_b, sizeof pairs_a)) { printf("frame %ld (%s): the converters differ\n", frame, what); return 0; }
  if (memcmp(&seq_a, &seq_b, sizeof seq_a)) { printf("frame %ld (%s): the sequencers differ\n", frame, what); return 0; }
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: see the header comment\n"); return 2; }
  const char *smp_path = 0;
  long prime = -1;
  int a = 3;
  for (; a < argc && argv[a][0] == '-' && argv[a][1] == '-'; a += 2) {
    if (!strcmp(argv[a], "--samples")) smp_path = argv[a + 1];
    else if (!strcmp(argv[a], "--prime")) prime = strtol(argv[a + 1], 0, 10);
  }
  if (argc - a < 8) { fprintf(stderr, "usage: see the header comment\n"); return 2; }
  MMLPairsCfg cfg;
  memset(&cfg, 0, sizeof cfg);
  cfg.fifo = (uint16_t)strtol(argv[a], 0, 0);
  uint8_t *f8[] = {&cfg.fifo_pairs, &cfg.pairs_per_grab, &cfg.lut_page, &cfg.op_stride, &cfg.op_port,
                   &cfg.voices, &cfg.idle_after_gen};
  for (int k = 0; k < 7; k++) *f8[k] = (uint8_t)strtol(argv[a + 1 + k], 0, 0);

  long len = 0, slen = 0;
  unsigned char *mmb = slurp(argv[1], &len), *smp = smp_path ? slurp(smp_path, &slen) : 0;
  if (!mmb || (smp_path && !smp)) { fprintf(stderr, "cannot read the inputs\n"); return 2; }
  const long frames = strtol(argv[2], 0, 10);
  memset(&seq_a, 0, sizeof seq_a);
  memset(&seq_b, 0, sizeof seq_b);
  if (mml_load(&seq_a, mmb, (uint32_t)len) || mml_load(&seq_b, mmb, (uint32_t)len)) { fprintf(stderr, "mml_load failed\n"); return 2; }
  if (smp && (mml_load_samples(&seq_a, smp, (uint32_t)slen, 0) || mml_load_samples(&seq_b, smp, (uint32_t)slen, 0))) {
    fprintf(stderr, "bad sample bank\n");
    return 2;
  }
  mmlp_init(&pairs_a, &cfg);
  mmlp_init(&pairs_b, &cfg);
  uint8_t slot[MML_SLOT_SIZE];
  long f = 0;
  if (prime >= 0) {
    mml_prime_tracks(&seq_a);
    mml_prime_tracks(&seq_b);
    for (long k = 0; k < prime; k++, f++) {
      mmlp_slot(&pairs_a, slot, (uint16_t)mml_render_frame(&seq_a, slot));
      mmlp_render(&pairs_b, &seq_b);
      if (!same(f, "primed")) return 1;
    }
    for (uint8_t i = 0; i < mml_track_count(&seq_a); i++) {
      mml_start_track(&seq_a, mml_track_id(&seq_a, i));
      mml_start_track(&seq_b, mml_track_id(&seq_b, i));
    }
  } else {
    mml_start_all(&seq_a);
    mml_start_all(&seq_b);
  }
  for (long k = 0; k < frames; k++, f++) {
    mmlp_slot(&pairs_a, slot, (uint16_t)mml_render_frame(&seq_a, slot));
    mmlp_render(&pairs_b, &seq_b);
    if (!same(f, "render")) return 1;
    if (mml_done(&seq_a)) break;
  }
  while (mml_pending(&seq_a)) {
    mmlp_slot(&pairs_a, slot, (uint16_t)mml_drain_frame(&seq_a, slot));
    mmlp_drain(&pairs_b, &seq_b);
    if (!same(f++, "drain")) return 1;
  }
  printf("ok %ld\n", f);
  return 0;
}
