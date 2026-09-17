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
#define PCM_VOL 3
#define PCM_RETARGET 4
#define PCM_MASTER 5
static const uint8_t PCM_LEN[6] = {0, 9, 0, 3, 6, 2};

/* The state block's ops (driver.md §6.1), for voice v. */
#define OP_IDLE 0
#define OP_LEVEL(v) ((uint8_t)(1 + 9 * (v)))
#define OP_SRC(v) ((uint8_t)(2 + 9 * (v)))
#define OP_START(v) ((uint8_t)(8 + 9 * (v)))
#define OP_RETARGET(v) ((uint8_t)(9 + 9 * (v)))

/* How far ahead of the last-read consumer index the head is placed: past what
 * the consumer takes between two grabs. The engine takes 16 pairs a lap
 * (~2 a millisecond); the SGDK host grabs from the vertical interrupt and from
 * a horizontal one at line 93, so the longer gap is 131 lines on NTSC
 * (8.3 ms, ~17 pairs) and 182 on PAL (11.6 ms, ~23). 32 covers both with room;
 * a grab later than that finds out itself (mmlp_in_time) and copies nothing. */
#define MMLP_AHEAD 32

/* …and with ONE grab a frame (the host's VBlank-only mode), the gap is the
 * whole frame: 16.7 ms on NTSC (~34 pairs) and 20 ms on PAL (~40), so the
 * head goes 48 ahead. The page holds 128; 48 + a grab's 8 stays well clear. */

/* A voice's rung page: silence for the sequencer's mute (8) or a total past
 * the last rung (-36 dB), else page 7 - total (driver.md §14). */
uint8_t mmlp_level_page(const MMLPairsCfg *cfg, uint8_t shift, uint8_t master_shift) {
  uint16_t total = (uint16_t)shift + master_shift;
  return (uint8_t)(cfg->lut_page + (shift >= 8 || total > 6 ? 0 : 7 - total));
}

void mmlp_init(MMLPairs *p, const MMLPairsCfg *cfg) {
  const MMLPairsCfg c = *cfg;
  uint8_t *b = (uint8_t *)p;
  for (uint32_t i = 0; i < sizeof(*p); i++) b[i] = 0;
  p->cfg = c;
  if (p->cfg.voices > MMLP_VOICES) p->cfg.voices = MMLP_VOICES;
  p->head_valid = 0;
  for (uint8_t v = 0; v < MMLP_VOICES; v++) {
    p->shift[v] = 0xff;
    p->page[v] = 0xff;
    p->since_gen[v] = 0xff;
  }
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

static uint16_t rd16le(const uint8_t *c) { return (uint16_t)(c[0] | (c[1] << 8)); }

/* The staged bytes that changed, in op order, then remembered. */
static void stage(MMLPairs *p, uint8_t v, uint8_t first, const uint8_t *vals, uint8_t n) {
  for (uint8_t k = 0; k < n; k++) {
    uint8_t at = (uint8_t)(first + k);
    if (!p->staged_valid[v] || vals[k] != p->staged[v][at]) {
      store(p, (uint8_t)(OP_SRC(v) + at), vals[k]);
      p->staged[v][at] = vals[k];
    }
  }
}

static void level(MMLPairs *p, uint8_t v) {
  uint8_t pg = mmlp_level_page(&p->cfg, p->shift[v], p->master_shift);
  if (pg != p->page[v]) { store(p, OP_LEVEL(v), pg); p->page[v] = pg; }
}

static void pcm_command(MMLPairs *p, const uint8_t *c) {
  const MMLPairsCfg *cfg = &p->cfg;
  switch (c[0]) {
  case PCM_START: {
    uint8_t v = c[1];
    if (v >= cfg->voices) { p->fault++; return; }
    p->shift[v] = c[2];
    level(p, v);
    /* ONLY WHAT CHANGED. The staged bytes are the host's alone (the engine reads
     * them at the edge and never writes them), so the block still holds the last
     * values: a drum hit on the same sample is one pair, not eight. */
    const uint16_t src = rd16le(c + 3), end = rd16le(c + 5), wrap = rd16le(c + 7);
    const uint8_t vals[6] = {(uint8_t)src, (uint8_t)(src >> 8), (uint8_t)end, (uint8_t)(end >> 8),
                             (uint8_t)wrap, (uint8_t)(wrap >> 8)};
    stage(p, v, 0, vals, 6);
    p->staged_valid[v] = 1;
    p->start_gen[v] = (uint8_t)(p->start_gen[v] + 1);
    store(p, OP_START(v), p->start_gen[v]);
    return;
  }
  case PCM_RETARGET: {
    uint8_t v = c[1];
    if (v >= cfg->voices) { p->fault++; return; }
    const uint16_t end = rd16le(c + 2), wrap = rd16le(c + 4);
    const uint8_t vals[4] = {(uint8_t)end, (uint8_t)(end >> 8), (uint8_t)wrap, (uint8_t)(wrap >> 8)};
    stage(p, v, 2, vals, 4);
    p->end_gen[v] = (uint8_t)(p->end_gen[v] + 1);
    store(p, OP_RETARGET(v), p->end_gen[v]);
    return;
  }
  case PCM_VOL: {
    uint8_t v = c[1];
    if (v >= cfg->voices) { p->fault++; return; }
    p->shift[v] = c[2];
    level(p, v);
    return;
  }
  case PCM_MASTER:
    p->master_shift = c[1];
    for (uint8_t v = 0; v < cfg->voices; v++)
      if (p->shift[v] != 0xff) level(p, v);
    return;
  default:
    return;
  }
}

static void slot_body(MMLPairs *p, const uint8_t *s, uint16_t len);

static void frame_begin(MMLPairs *p) {
  p->q_work = p->q_head;
  p->psg_work = p->psg_head;
}

/* The publication: this frame's ends first, then the heads, then the frame
 * count — one 16-bit store each. A grab bounds itself by the ends of the
 * frames it may send, never by the heads, so it cannot see this frame until
 * frames_in says it exists. */
static void frame_publish(MMLPairs *p) {
  p->end_q[p->frames_in & (MMLP_FRAMES - 1)] = p->q_work;
  p->end_psg[p->frames_in & (MMLP_FRAMES - 1)] = p->psg_work;
  p->psg_head = p->psg_work;
  p->q_head = p->q_work;
  p->frames_in = (uint16_t)(p->frames_in + 1);
}

/* A slot's PCM commands, into pairs ahead of its register writes; `len`
 * bounds the run. Returns the bytes used, or 0xffff for a malformed run. */
static uint16_t pcm_run(MMLPairs *p, const uint8_t *c, uint16_t len, uint8_t npcm) {
  uint16_t i = 0;
  for (; npcm > 0 && i < len; npcm--) {
    uint8_t op = c[i];
    if (op > 5 || !PCM_LEN[op]) return 0xffff;   /* malformed: stop here */
    if ((uint16_t)(i + PCM_LEN[op]) > len) return 0xffff;
    pcm_command(p, c + i);
    i = (uint16_t)(i + PCM_LEN[op]);
  }
  return i;
}

MMLP_HOT void psg_push(MMLPairs *p, uint8_t b) {
  uint16_t next = (uint16_t)((p->psg_work + 1) & (MMLP_PSG - 1));
  if (next != p->psg_tail) { p->psg[p->psg_work] = b; p->psg_work = next; }
}

void mmlp_slot(MMLPairs *p, const uint8_t *s, uint16_t len) {
  frame_begin(p);
  slot_body(p, s, len);
  frame_publish(p);
}

/* THE SAME FRAME, FROM THE SEQUENCER'S QUEUE. What mmlp_slot does with the
 * bytes of an encoded slot, done with the view the sequencer describes it by
 * (mmlispseq.h MMLFrameView): the PCM commands held, then per sub-slot the PSG
 * bytes and the port-0 writes in one pass and the port-1 writes in a second —
 * the order the slot's runs put them in. No slot is packed or parsed; the pair
 * gate runs both paths side by side on every score and requires the same
 * converter state after every frame. */
static void view_body(MMLPairs *p, const MMLFrameView *v) {
  if (pcm_run(p, v->pcm, v->pcm_len, v->pcm_count) == 0xffff) return;
  uint16_t done = 0;
  for (uint8_t sub = 0; sub < MML_SLOT_SUBS; sub++) {
    const uint16_t end = v->end[sub];
    uint16_t at = (uint16_t)((v->first + done) & (MML_WRITE_QUEUE - 1));
    for (uint16_t i = done; i < end; i++) {
      const MMLWrite *w = &v->q[at];
      if (w->port == 2) psg_push(p, w->data);
      else if (w->port == 0) push(p, 0, w->addr, w->data);
      at = (uint16_t)((at + 1) & (MML_WRITE_QUEUE - 1));
    }
    at = (uint16_t)((v->first + done) & (MML_WRITE_QUEUE - 1));
    for (uint16_t i = done; i < end; i++) {
      const MMLWrite *w = &v->q[at];
      if (w->port == 1) push(p, 1, w->addr, w->data);
      at = (uint16_t)((at + 1) & (MML_WRITE_QUEUE - 1));
    }
    done = end;
  }
}

void mmlp_render(MMLPairs *p, MMLSeq *s) {
  MMLFrameView v;
  mml_render_frame_view(s, &v);
  frame_begin(p);
  view_body(p, &v);
  frame_publish(p);
  mml_view_done(s, &v);
}

void mmlp_drain(MMLPairs *p, MMLSeq *s) {
  MMLFrameView v;
  mml_drain_frame_view(s, &v);
  frame_begin(p);
  view_body(p, &v);
  frame_publish(p);
  mml_view_done(s, &v);
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
  if (len < 2) return;
  i += 1;                                   /* n_writes */
  uint8_t npcm = s[i++];
  uint16_t used = pcm_run(p, s + i, (uint16_t)(len - i), npcm);
  if (used == 0xffff) return;
  i = (uint16_t)(i + used);
  for (uint8_t sub = 0; sub < MML_SLOT_SUBS; sub++) {
    if (i >= len) return;
    uint8_t npsg = s[i++];
    for (; npsg > 0 && i < len; npsg--) psg_push(p, s[i++]);
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
/* The voice a staged store (SRC, END, WRAP) belongs to, or 0xff. */
MMLP_HOT uint8_t staged_voice(const MMLPairsCfg *cfg, uint8_t op) {
  if (op == 0 || op >= (uint8_t)(1 + 9 * cfg->voices)) return 0xff;
  const uint8_t k = (uint8_t)((op - 1) % 9);
  return k >= 1 && k <= 6 ? (uint8_t)((op - 1) / 9) : 0xff;
}
/* The voice a generation pair (START, RETARGET) belongs to, or 0xff. */
MMLP_HOT uint8_t gen_voice(const MMLPairsCfg *cfg, uint8_t op) {
  if (op == 0 || op >= (uint8_t)(1 + 9 * cfg->voices)) return 0xff;
  const uint8_t k = (uint8_t)((op - 1) % 9);
  return k >= 7 ? (uint8_t)((op - 1) / 9) : 0xff;
}
MMLP_HOT void since_add(MMLPairs *p, uint16_t n) {
  for (uint8_t v = 0; v < MMLP_VOICES; v++)
    p->since_gen[v] = (uint8_t)(p->since_gen[v] + n > 255 ? 255 : p->since_gen[v] + n);
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
  for (uint8_t v = 0; v < MMLP_VOICES; v++) p->undo_since[v] = p->since_gen[v];
  p->undo_n = 0;
  /* WHERE THE PAIRS GO (pair-host.mjs): ahead of the index read last time by
   * more than the consumer takes between grabs — and never behind the pairs
   * written last time that it may not have reached yet. */
  if (fifo_lo == 0xff) { *dst = 0; return 0; }            /* no index yet */
  uint8_t c = (uint8_t)((fifo_lo >> 1) & MASK);
  uint8_t h = (uint8_t)((c + (cfg->ahead ? cfg->ahead : MMLP_AHEAD)) & MASK);
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
    /* A GENERATION IS APPLIED AT THE VOICE'S NEXT BLOCK EDGES, not when its
     * pair is read: the staged bytes it names are read a few expander steps
     * later. A staged store for the same voice read in that window would be
     * applied by the wrong generation, so `idle_after_gen` pairs — computed
     * from the image's slots (tools/build-engine.mjs) — go first. */
    if (port == 0xff) {
      const uint8_t sv = staged_voice(cfg, op);
      if (sv != 0xff && p->since_gen[sv] < cfg->idle_after_gen) {
        ops[n] = OP_IDLE; vals[n] = 0; n++;
        since_add(p, 1);
        continue;
      }
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
    since_add(p, need);
    if (port == 0xff) { const uint8_t gv = gen_voice(cfg, op); if (gv != 0xff) p->since_gen[gv] = 0; }
  }
  /* The rest of the grab is IDLE — only when there is a grab to write: with
   * nothing planned the host reads the index and writes nothing. */
  if (n)
    for (uint16_t k = n; k < cfg->pairs_per_grab; k++) { ops[k] = OP_IDLE; vals[k] = 0; }
  *dst = (uint16_t)(cfg->fifo + 2 * p->head);
  p->head = (uint8_t)((p->head + n) & MASK);
  p->pairs_written = (uint16_t)(p->pairs_written + n);
  p->undo_n = (uint8_t)n;
  return n;
}

void mmlp_abort(MMLPairs *p) {
  p->q_tail = p->undo_tail;
  p->chip_port = p->undo_port;
  for (uint8_t v = 0; v < MMLP_VOICES; v++) p->since_gen[v] = p->undo_since[v];
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
