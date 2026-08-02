/* Host harness for the §12.2 gate: read an MMB, render its slot stream, write
 * it to stdout as [u16 len][bytes] per frame.
 *
 * The point of keeping mmlispseq.c free of SGDK is exactly this — both sides of
 * the gate run on the host, so comparing the C against drv-player.js needs no
 * emulator and no assembler, and both are debuggable.
 *
 *   gate_main <song.mmb> [max_frames] [--cmds commands.txt] [--samples bank.smp]
 *                                    [--pump depth]
 *
 * commands.txt is one host command per line — "frame cmd a0 a1 a2" — applied at
 * the top of the matching frame, which is where the reference applies them too.
 * bank.smp is the SAMPLE_BANK a PCM score needs; it is a separate ROM bank on
 * the target, so it is a separate file here.
 *
 * --pump drives the stream through the REAL ring transport (mml_pump) with a
 * model of the Z80 consuming one slot per its own vblank, instead of calling
 * mml_render_frame directly. The bytes must come out identical — the ring is a
 * pipeline, not a filter — which is what tools/ring-gate.mjs checks.
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

/* ── --pump: the stream through the real ring ──────────────────────────────
 * A model of the far side: the engine consumes exactly one slot per its own
 * vblank, and the host calls MMLisp_frame once per frame — except every 7th,
 * which stands in for a game frame that overran (driver.md §3.4: at depth N the
 * ring absorbs N-1 of those). Emits exactly `frames` slots and stops, so the
 * comparison against the plain path needs no agreement about where a song ends.
 */
enum { RING_MAX = 8 };
static unsigned char ring[RING_MAX][MML_SLOT_SIZE];
static uint16_t ring_len[RING_MAX];

static void ring_sink(void *ctx, uint8_t index, const uint8_t *bytes, uint16_t len) {
  (void)ctx;
  memcpy(ring[index], bytes, len);
  ring_len[index] = len;
}

static int run_pumped(MMLSeq *seq, int depth, long frames) {
  if (depth < 2 || depth > RING_MAX) {
    fprintf(stderr, "--pump depth must be 2..%d\n", RING_MAX);
    return 2;
  }
  uint8_t head = 0, tail = 0;
  long emitted = 0;
  for (long host = 0; emitted < frames; host++) {
    if (host % 7 != 6) {
      head = mml_pump(seq, head, tail, (uint8_t)depth, ring_sink, NULL);
      /* §6.6: the call tops the ring up, so it leaves the ring FULL and a
       * second call in the same frame must do nothing at all. */
      uint8_t again = mml_pump(seq, head, tail, (uint8_t)depth, ring_sink, NULL);
      if (again != head) {
        fprintf(stderr, "pump is not self-limiting: %u then %u\n", head, again);
        return 2;
      }
    }
    if (tail == head) continue; /* ring empty: the engine holds, not an error */
    emit_slot(ring[tail], ring_len[tail]);
    emitted++;
    tail = (uint8_t)(tail + 1 >= depth ? 0 : tail + 1);
  }
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: gate_main <song.mmb> [max_frames] [--cmds f] [--samples f]\n");
    return 2;
  }
  long max_frames = argc > 2 && argv[2][0] != '-' ? strtol(argv[2], NULL, 10) : 36000;
  const char *cmd_path = 0, *smp_path = 0;
  int pump_depth = 0;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--cmds") && i + 1 < argc) cmd_path = argv[++i];
    else if (!strcmp(argv[i], "--samples") && i + 1 < argc) smp_path = argv[++i];
    else if (!strcmp(argv[i], "--pump") && i + 1 < argc)
      pump_depth = (int)strtol(argv[++i], NULL, 10);
  }
  if (pump_depth && cmd_path) {
    /* Commands are keyed to HOST frames, and under the ring a host frame is not
     * a render frame — so the two would not be comparable. The ring arithmetic
     * does not depend on them anyway. */
    fprintf(stderr, "--pump and --cmds are mutually exclusive\n");
    return 2;
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
  if (pump_depth) return run_pumped(&seq, pump_depth, max_frames);
  for (long i = 0; i < max_frames; i++) {
    for (int c = 0; c < ncmds; c++)
      if (cmds[c].frame == i)
        mml_command(&seq, (uint8_t)cmds[c].cmd, (uint8_t)cmds[c].a0,
                    (uint8_t)cmds[c].a1, (uint8_t)cmds[c].a2);
    uint32_t n = mml_render_frame(&seq, slot);
    emit_slot(slot, n);
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
  if (seq.stopped) {
    fprintf(stderr, "undecoded opcode 0x%02x at frame %u\n", seq.stopped_op,
            (unsigned)seq.stopped_frame);
    return 3;
  }
  return 0;
}
