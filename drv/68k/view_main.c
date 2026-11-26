/* Host harness for the pairs gate's VIEW check (tools/pairs-gate.mjs): the
 * SGDK host takes each frame into the converter straight from the sequencer
 * (mmlp_render); the rest of the gates follow the record path (gate_main
 * --frames + mmlp_frame), which pairs-gate holds to the JS reference. Here
 * the same score runs down both paths side by side — two sequencers, two
 * converters — and after every frame the two converters must be byte for
 * byte the same, and so must the two sequencers.
 *
 *   view_main <song.mmb> <frames> [--samples bank.smp] [--prime K] [--banked 1]
 *             <fifo> <fifo_pairs> <ppg> <lut_page> <op_port> <voices> <idle_after_gen>
 *
 * Prints "ok <frames>" or the first frame the two differ at, and exits 1.
 *
 * --banked 1: the host's path alone, with the block-banked image's converter
 * (banked_writes, which the record path never takes) — each frame rendered,
 * then grabbed as pairs_main grabs (the same modelled engine), the pairs and
 * PSG bytes written out as pairs_main writes them. banked_writes has no JS
 * twin; banked:gate holds this stream to the one recorded. */
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

/* --banked: one grab, as pairs_main's grab() (the engine 17 pairs on, every
 * seventh grab 10 more between the read and the write). */
static unsigned consumer = 0, ngrab = 0;
static void grab_out(MMLPairs *p, const MMLPairsCfg *cfg) {
  uint8_t ops[MMLP_MAX_GRAB], vals[MMLP_MAX_GRAB], psg[256];
  uint16_t dst = 0;
  consumer = (consumer + 17) % cfg->fifo_pairs;
  const uint8_t fresh = (uint8_t)(2 * consumer);
  uint16_t n = mmlp_plan(p, fresh, p->frames_in, ops, vals, &dst);
  if (ngrab++ % 7 == 6) consumer = (consumer + 10) % cfg->fifo_pairs;
  if (n && !mmlp_in_time(fresh, dst, (uint8_t)(2 * consumer))) { mmlp_abort(p); n = 0; fputc('L', stdout); }
  fputc('G', stdout);
  fputc(dst & 0xff, stdout); fputc(dst >> 8, stdout);
  fputc(n, stdout);
  for (uint16_t k = 0; k < n; k++) { fputc(ops[k], stdout); fputc(vals[k], stdout); }
  const uint16_t np = mmlp_psg_take(p, p->frames_in, psg, sizeof psg);
  fputc('P', stdout);
  fputc(np & 0xff, stdout);
  fwrite(psg, 1, np, stdout);
}

static int banked_wire(const MMLPairsCfg *cfg, long frames) {
  MMLPairsCfg banked = *cfg;
  banked.banked = 1;
  mmlp_init(&pairs_b, &banked);
  mml_start_all(&seq_b);
  for (long k = 0; k < frames; k++) {
    mmlp_render(&pairs_b, &seq_b);
    grab_out(&pairs_b, &banked);
    grab_out(&pairs_b, &banked);
    if (mml_done(&seq_b)) break;
  }
  while (mml_pending(&seq_b)) {
    mmlp_drain(&pairs_b, &seq_b);
    grab_out(&pairs_b, &banked);
    grab_out(&pairs_b, &banked);
  }
  for (int g = 0; g < 4096 && mmlp_pending(&pairs_b); g++) grab_out(&pairs_b, &banked);
  return 0;
}

static int same(long frame, const char *what) {
  if (memcmp(&pairs_a, &pairs_b, sizeof pairs_a)) { printf("frame %ld (%s): the converters differ\n", frame, what); return 0; }
  if (memcmp(&seq_a, &seq_b, sizeof seq_a)) { printf("frame %ld (%s): the sequencers differ\n", frame, what); return 0; }
  return 1;
}

/* One frame of seq_a as the record gate_main --frames writes, into pairs_a. */
static uint8_t rec[1 + 256 + 3 * MML_WRITE_QUEUE];
static void by_record(int drain) {
  MMLFrameView v;
  if (drain) mml_drain_frame_view(&seq_a, &v);
  else mml_render_frame_view(&seq_a, &v);
  const uint16_t n = v.end[MML_SLOT_SUBS - 1];
  uint32_t len = 0;
  rec[len++] = v.pcm_count;
  for (uint16_t i = 0; i < v.pcm_len; i++) rec[len++] = v.pcm[i];
  for (uint16_t i = 0; i < n; i++) {
    const MMLWrite *w = &v.q[(uint16_t)(v.first + i) & (MML_WRITE_QUEUE - 1)];
    rec[len++] = w->port;
    rec[len++] = w->addr;
    rec[len++] = w->data;
  }
  mml_view_done(&seq_a, &v);
  mmlp_frame(&pairs_a, rec, (uint16_t)len);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: see the header comment\n"); return 2; }
  const char *smp_path = 0;
  long prime = -1;
  int a = 3, banked = 0;
  for (; a < argc && argv[a][0] == '-' && argv[a][1] == '-'; a += 2) {
    if (!strcmp(argv[a], "--samples")) smp_path = argv[a + 1];
    else if (!strcmp(argv[a], "--prime")) prime = strtol(argv[a + 1], 0, 10);
    else if (!strcmp(argv[a], "--banked")) banked = atoi(argv[a + 1]);
  }
  if (argc - a < 7) { fprintf(stderr, "usage: see the header comment\n"); return 2; }
  MMLPairsCfg cfg;
  memset(&cfg, 0, sizeof cfg);
  cfg.fifo = (uint16_t)strtol(argv[a], 0, 0);
  uint8_t *f8[] = {&cfg.fifo_pairs, &cfg.pairs_per_grab, &cfg.lut_page, &cfg.op_port,
                   &cfg.voices, &cfg.idle_after_gen};
  for (int k = 0; k < 6; k++) *f8[k] = (uint8_t)strtol(argv[a + 1 + k], 0, 0);

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
  if (banked) return banked_wire(&cfg, frames);
  mmlp_init(&pairs_a, &cfg);
  mmlp_init(&pairs_b, &cfg);
  long f = 0;
  if (prime >= 0) {
    mml_prime_tracks(&seq_a);
    mml_prime_tracks(&seq_b);
    for (long k = 0; k < prime; k++, f++) {
      by_record(0);
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
    by_record(0);
    mmlp_render(&pairs_b, &seq_b);
    if (!same(f, "render")) return 1;
    if (mml_done(&seq_a)) break;
  }
  while (mml_pending(&seq_a)) {
    by_record(1);
    mmlp_drain(&pairs_b, &seq_b);
    if (!same(f++, "drain")) return 1;
  }
  printf("ok %ld\n", f);
  return 0;
}
