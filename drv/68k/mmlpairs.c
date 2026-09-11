/* MMLispDRV — slots into pairs (see mmlpairs.h). Portable C99, no SGDK. */
#include "mmlpairs.h"
#include "mmlispseq.h"

/* Small hot helpers inline: m68k-gcc passes arguments on the stack and saves
 * registers per call, which for push() was most of its cost. */
#if defined(__GNUC__)
#define MMLP_HOT static inline __attribute__((always_inline))
#else
#define MMLP_HOT static inline
#endif

/* The slot's PCM opcodes (driver.md §6.3), as mmlispseq.c emits them. */
#define PCM_START 1
#define PCM_STOP 2
#define PCM_VOL 3
#define PCM_LOOP 4
#define PCM_MASTER 5

/* How far ahead of the last-read consumer index the head is placed: past what
 * the consumer takes between two grabs. The engine takes 16 pairs a lap
 * (~2 a millisecond); the SGDK host grabs from the vertical interrupt and from
 * a horizontal one at line 93, so the longer gap is 131 lines on NTSC
 * (8.3 ms, ~17 pairs) and 182 on PAL (11.6 ms, ~23). 32 covers both with room;
 * a grab later than that finds out itself (mmlp_in_time) and copies nothing. */
#define MMLP_AHEAD 32

/* The 6 dB shift grid onto the 15-level linear family: round(14 * 2^-s).
 * shift 8 is the sequencer's mute. */
static const uint8_t LEVEL_OF_SHIFT[9] = {14, 7, 4, 2, 1, 0, 0, 0, 0};

uint8_t mmlp_level_page(const MMLPairsCfg *cfg, uint8_t shift) {
  uint8_t l = shift > 8 ? 0 : LEVEL_OF_SHIFT[shift];
  if (l > (uint8_t)(cfg->levels - 1)) l = (uint8_t)(cfg->levels - 1);
  return (uint8_t)(cfg->lut_page + l);
}
uint8_t mmlp_master_page(const MMLPairsCfg *cfg, uint8_t shift) { return mmlp_level_page(cfg, shift); }

void mmlp_init(MMLPairs *p, const MMLPairsCfg *cfg) {
  const MMLPairsCfg c = *cfg;
  uint8_t *b = (uint8_t *)p;
  for (uint32_t i = 0; i < sizeof(*p); i++) b[i] = 0;
  p->cfg = c;
  p->cfg.staged_run = c.op_src_hi == c.op_src_lo + 1 && c.op_end_lo == c.op_src_lo + 2 &&
                      c.op_end_hi == c.op_src_lo + 3 && c.op_step == c.op_src_lo + 4;
  p->head_valid = 0;
  p->since_start = 0xff;
  p->level_page = mmlp_level_page(&c, 0);
  p->master_page = mmlp_master_page(&c, 0);
}

/* The producer fills from its own cursor (q_work) and publishes q_head once,
 * at the end of a slot: an interrupt-side grab sees all of a frame's pairs or
 * none of them, never a pitch pair's upper half without its lower. */
MMLP_HOT void push(MMLPairs *p, uint8_t port, uint8_t op, uint8_t val) {
  uint16_t next = (uint16_t)((p->q_work + 1) & (MMLP_QUEUE - 1));
  if (next == p->q_tail) { p->overflow++; return; }
  p->q_port[p->q_work] = port;
  p->q_op[p->q_work] = op;
  p->q_val[p->q_work] = val;
  p->q_work = next;
}
MMLP_HOT void store(MMLPairs *p, uint8_t op, uint8_t val) { push(p, 0xff, op, val); }

uint16_t mmlp_pending(const MMLPairs *p) {
  return (uint16_t)((p->q_head + MMLP_QUEUE - p->q_tail) & (MMLP_QUEUE - 1));
}

/* The power of two nearest an increment's integer part, for the fixed-pitch
 * engine: the bake makes it exact (mmb.md §10.1); anything else is rounded and
 * counted, not silently played at the wrong octave. */
static uint8_t step_of(MMLPairs *p, uint8_t inc_i, uint16_t inc_frac) {
  if (inc_frac == 0 && (inc_i == 1 || inc_i == 2 || inc_i == 4 || inc_i == 8)) return inc_i;
  p->step_rounded++;
  if (inc_i >= 6) return 8;
  if (inc_i >= 3) return 4;
  if (inc_i >= 2 || (inc_i == 1 && inc_frac >= 0x8000)) return 2;
  return 1;
}

static void pcm_command(MMLPairs *p, const uint8_t *c) {
  const MMLPairsCfg *cfg = &p->cfg;
  switch (c[0]) {
  case PCM_START: {
    if (c[1] != 0) { p->dropped_voice++; return; }
    uint16_t addr = (uint16_t)(c[7] | (c[8] << 8));
    uint16_t left = (uint16_t)(c[9] | (c[10] << 8));
    uint16_t tail = (uint16_t)(c[13] | (c[14] << 8));
    uint16_t inc_frac = (uint16_t)(c[15] | (c[16] << 8));
    uint8_t step = step_of(p, c[17], inc_frac);
    /* Profile 1 plays the sample ONCE, loop body and tail included. The engine
     * parks at the last block edge before it would read past the end
     * (R28 §63.3 D2), so the END it gets is sampleEnd - 16 * step. */
    uint32_t end = (uint32_t)addr + left + tail;
    uint32_t sent = end > (uint32_t)16 * step ? end - (uint32_t)16 * step : 0;
    if (sent < addr) sent = addr;
    if (sent > 0xffff) sent = 0xffff;
    /* ONLY WHAT CHANGED. The staged bytes are the host's alone (the engine
     * copies them at the START edge and never writes them), so the block still
     * holds the last start's values: a drum hit on the same sample is one pair,
     * not seven — and each pair is ~0.5 ms of the wire in front of the FM
     * writes it shares a slot with. */
    uint8_t lv = mmlp_level_page(cfg, c[3]);
    const uint8_t v[5] = {(uint8_t)(addr & 0xff), (uint8_t)(addr >> 8), (uint8_t)(sent & 0xff), (uint8_t)(sent >> 8), step};
    const uint8_t o[5] = {cfg->op_src_lo, cfg->op_src_hi, cfg->op_end_lo, cfg->op_end_hi, cfg->op_step};
    if (!p->staged_valid || lv != p->level_page) store(p, cfg->op_level, lv);
    p->level_page = lv;
    for (uint8_t k = 0; k < 5; k++)
      if (!p->staged_valid || v[k] != p->staged[k]) { store(p, o[k], v[k]); p->staged[k] = v[k]; }
    p->staged_valid = 1;
    p->start_gen = (uint8_t)(p->start_gen + 1);
    store(p, cfg->op_start, p->start_gen);
    return;
  }
  case PCM_STOP:
    if (c[1] != 0) { p->dropped_voice++; return; }
    p->stop_gen = (uint8_t)(p->stop_gen + 1);
    store(p, cfg->op_stop, p->stop_gen);
    return;
  case PCM_VOL:
    if (c[1] != 0) { p->dropped_voice++; return; }
    p->level_page = mmlp_level_page(cfg, c[2]);
    store(p, cfg->op_level, p->level_page);
    return;
  case PCM_MASTER:
    p->master_page = mmlp_master_page(cfg, c[1]);
    store(p, cfg->op_master, p->master_page);
    return;
  case PCM_LOOP:
    p->dropped_loop++;
    return;
  default:
    return;
  }
}

static const uint8_t PCM_LEN[6] = {0, 18, 2, 3, 6, 2};

static void slot_body(MMLPairs *p, const uint8_t *s, uint16_t len);

/* PCM COMMANDS GO OUT ONE SLOT LATE. The sequencer starts a PCM track a frame
 * ahead of every other track (mmlispseq.c, the armed frame), which cancelled
 * the ring mixer's one-frame feed lag. This engine has no such lag — a start
 * travels in the pair page beside the FM writes of its slot and sounds within
 * 34 samples — so a slot's PCM commands are held and sent with the NEXT slot,
 * ahead of its FM: back on the beat (gate-score's SYNC row, m3-pcm-sync). */
void mmlp_slot(MMLPairs *p, const uint8_t *s, uint16_t len) {
  p->q_work = p->q_head;
  p->psg_work = p->psg_head;
  for (uint16_t i = 0; i < p->held_len;) {
    pcm_command(p, p->held + i);
    i = (uint16_t)(i + PCM_LEN[p->held[i]]);
  }
  p->held_len = 0;
  slot_body(p, s, len);
  /* The publication: this frame's ends first, then the heads, then the frame
   * count — one 16-bit store each. A grab bounds itself by the ends of the
   * frames it may send, never by the heads, so it cannot see this frame until
   * frames_in says it exists. */
  p->end_q[p->frames_in & (MMLP_FRAMES - 1)] = p->q_work;
  p->end_psg[p->frames_in & (MMLP_FRAMES - 1)] = p->psg_work;
  p->psg_head = p->psg_work;
  p->q_head = p->q_work;
  p->frames_in = (uint16_t)(p->frames_in + 1);
}

/* The number of released frames that are queued, and so the last one's index;
 * frames beyond MMLP_FRAMES back are sent regardless (the host never renders
 * that far ahead). */
static uint16_t released(const MMLPairs *p, uint16_t release) {
  const uint16_t in = p->frames_in;
  if ((int16_t)(release - in) >= 0) return in;   /* everything queued is due */
  uint16_t avail = release;
  if ((uint16_t)(in - avail) >= MMLP_FRAMES) avail = (uint16_t)(in - (MMLP_FRAMES - 1));
  return avail;
}

static void slot_body(MMLPairs *p, const uint8_t *s, uint16_t len) {
  uint16_t i = 0;
  if (len < 3) return;
  i += 2;                                   /* n_writes, chunk: the ring engine's */
  uint8_t npcm = s[i++];
  for (; npcm > 0 && i < len; npcm--) {
    uint8_t op = s[i];
    if (op < 1 || op > 5) return;           /* malformed: stop here */
    if ((uint16_t)(i + PCM_LEN[op]) > len) return;
    if ((uint16_t)(p->held_len + PCM_LEN[op]) <= MMLP_HELD) {
      for (uint8_t k = 0; k < PCM_LEN[op]; k++) p->held[p->held_len + k] = s[i + k];
      p->held_len = (uint16_t)(p->held_len + PCM_LEN[op]);
    } else {
      p->overflow++;
    }
    i = (uint16_t)(i + PCM_LEN[op]);
  }
  for (uint8_t v = 0; v < MML_PCM_VOICES; v++) {   /* the segment plan: not ours */
    if (i >= len) return;
    uint8_t n = s[i++];
    i = (uint16_t)(i + n);
  }
  for (uint8_t sub = 0; sub < MML_SLOT_SUBS; sub++) {
    if (i >= len) return;
    uint8_t npsg = s[i++];
    for (; npsg > 0 && i < len; npsg--) {
      uint16_t next = (uint16_t)((p->psg_work + 1) & (MMLP_PSG - 1));
      if (next != p->psg_tail) { p->psg[p->psg_work] = s[i]; p->psg_work = next; }
      i++;
    }
    for (uint8_t port = 0; port < 2; port++) {
      if (i >= len) return;
      uint8_t n = s[i++];
      for (; n > 0 && i + 1 < len; n--) { push(p, port, s[i], s[i + 1]); i = (uint16_t)(i + 2); }
    }
  }
}

/* The queues wrap with a mask (an int `%` is a libgcc call on the 68000). */
typedef char mmlp_queue_is_pow2[(MMLP_QUEUE & (MMLP_QUEUE - 1)) == 0 && (MMLP_PSG & (MMLP_PSG - 1)) == 0 ? 1 : -1];

MMLP_HOT int is_pitch_hi(uint8_t reg) { return (uint8_t)((reg & 0xf7) - 0xa4) <= 2; } /* $A4-$A6, $AC-$AE */
MMLP_HOT int is_staged(const MMLPairsCfg *cfg, uint8_t op) {
  /* The staged bytes are one run of the state block in the image's ABI
   * (source, end, step); mmlp_init checks that and falls back if not. */
  if (cfg->staged_run) return (uint8_t)(op - cfg->op_src_lo) <= (uint8_t)(cfg->op_step - cfg->op_src_lo);
  return op == cfg->op_src_lo || op == cfg->op_src_hi || op == cfg->op_end_lo || op == cfg->op_end_hi || op == cfg->op_step;
}

uint16_t mmlp_plan(MMLPairs *p, uint8_t fifo_lo, uint16_t release, uint8_t *ops, uint8_t *vals, uint16_t *dst) {
  const MMLPairsCfg *cfg = &p->cfg;
  /* The queue index this grab may not pass: the end of the last frame whose
   * time has come. */
  const uint16_t avail = released(p, release);
  const uint16_t lim = avail ? p->end_q[(avail - 1) & (MMLP_FRAMES - 1)] : p->q_tail;
  const uint8_t N = cfg->fifo_pairs, MASK = (uint8_t)(N - 1);
  p->grabs++;
  p->undo_tail = p->q_tail;
  p->undo_port = p->chip_port;
  p->undo_since = p->since_start;
  p->undo_n = 0;
  /* WHERE THE PAIRS GO (pair-host.mjs): ahead of the index read last time by
   * more than the consumer takes between grabs — and never behind the pairs
   * written last time that it may not have reached yet. */
  if (fifo_lo == 0xff) { *dst = 0; return 0; }            /* no index yet */
  uint8_t c = (uint8_t)((fifo_lo >> 1) & MASK);
  uint8_t h = (uint8_t)((c + MMLP_AHEAD) & MASK);
  if (p->head_valid) {
    uint8_t d_old = (uint8_t)((p->head - c) & MASK);
    uint8_t d_new = (uint8_t)((h - c) & MASK);
    if (d_old > d_new && d_old < 64) h = p->head;
  }
  /* A grab writes pairs_per_grab pairs, always — the real ones, then IDLE —
   * and never across the page end. So a head too near the end moves to 0: the
   * few pairs skipped are idle, and the engine reads them before position 0,
   * so nothing is read out of order. */
  if ((uint16_t)h + cfg->pairs_per_grab > N) h = 0;
  p->head = h;
  p->head_valid = 1;
  uint16_t n = 0;
  while (n < cfg->pairs_per_grab && p->q_tail != lim) {
    uint16_t t = p->q_tail;
    uint8_t port = p->q_port[t], op = p->q_op[t], val = p->q_val[t];
    /* A START IS COPIED AT THE NEXT BLOCK EDGE, not when its pair is read. The
     * expander reads up to three more pairs in the same block (sites b5/b9/b11,
     * and b3 in block 0), so staged bytes for the NEXT start read in that
     * window would be copied with this one. Three IDLE pairs after a START put
     * any staged store past the edge. Rare: it takes two starts with no FM
     * writes between them in the page. */
    if (port == 0xff && is_staged(cfg, op) && p->since_start < 3) {
      ops[n] = cfg->op_idle; vals[n] = 0; n++;
      p->since_start++;
      continue;
    }
    uint16_t need = 1;
    int port_change = port != 0xff && port != p->chip_port;
    if (port_change) need++;
    if (port != 0xff && is_pitch_hi(op)) need++;          /* the lower half rides along */
    if (n + need > cfg->pairs_per_grab) break;
    /* Counted from the head PLUS what this grab has already planned: checked
     * against the stale head, a second pair at position 126 went past the page
     * end into the state block (found by the model gate on m3-macro-multi). */
    if ((uint16_t)(((p->head - c) & MASK) + n + need) > (uint16_t)N - 8) break; /* the page is full */
    if (((uint16_t)p->head + n + need) > N) break;         /* never straddle the page end */
    if (port_change) {
      ops[n] = cfg->op_port; vals[n] = port; n++;
      p->chip_port = port;
    }
    ops[n] = op; vals[n] = val; n++;
    p->q_tail = (uint16_t)((t + 1) & (MMLP_QUEUE - 1));
    if (port != 0xff && is_pitch_hi(op) && p->q_tail != lim) {
      uint16_t u = p->q_tail;
      ops[n] = p->q_op[u]; vals[n] = p->q_val[u]; n++;
      p->q_tail = (uint16_t)((u + 1) & (MMLP_QUEUE - 1));
    }
    if (port == 0xff && op == cfg->op_start) p->since_start = 0;
    else p->since_start = (uint8_t)(p->since_start + need > 255 ? 255 : p->since_start + need);
  }
  /* The rest of the grab is IDLE — only when there is a grab to write: with
   * nothing planned the host reads the index and writes nothing. */
  if (n)
    for (uint16_t k = n; k < cfg->pairs_per_grab; k++) { ops[k] = cfg->op_idle; vals[k] = 0; }
  *dst = (uint16_t)(cfg->fifo + 2 * p->head);
  p->head = (uint8_t)((p->head + n) & MASK);
  p->pairs_written = (uint16_t)(p->pairs_written + n);
  p->undo_n = (uint8_t)n;
  return n;
}

void mmlp_abort(MMLPairs *p) {
  p->q_tail = p->undo_tail;
  p->chip_port = p->undo_port;
  p->since_start = p->undo_since;
  p->pairs_written = (uint16_t)(p->pairs_written - p->undo_n);
  p->undo_n = 0;
  p->head_valid = 0;
  p->late++;
}

uint16_t mmlp_psg_take(MMLPairs *p, uint16_t release, uint8_t *out, uint16_t max) {
  uint16_t n = 0;
  while (p->psg_tail != p->psg_mark && n < max) {
    out[n++] = p->psg[p->psg_tail];
    p->psg_tail = (uint16_t)((p->psg_tail + 1) & (MMLP_PSG - 1));
  }
  const uint16_t avail = released(p, release);
  if (avail) p->psg_mark = p->end_psg[(avail - 1) & (MMLP_FRAMES - 1)];
  return n;
}
