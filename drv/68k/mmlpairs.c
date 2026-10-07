/* MMLispDRV — frames into pairs (see mmlpairs.h). Portable C99, no SGDK. */
#include "mmlpairs.h"
#include "mmlispseq.h"

/* Small hot helpers inline: m68k-gcc passes arguments on the stack and saves
 * registers per call, which for push() was most of its cost. */
#if defined(__GNUC__)
#define MMLP_HOT static inline __attribute__((always_inline))
#else
#define MMLP_HOT static inline
#endif

/* The frame's PCM opcodes (driver.md §6.3), as mmlispseq.c emits them. */
#define PCM_START 1
#define PCM_VOL 3
#define PCM_RETARGET 4
#define PCM_MASTER 5
static const uint8_t PCM_LEN[7] = {0, 9, 0, 3, 6, 2, 11};

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
  p->last_fifo = 0xff;
  for (uint8_t ch=0; ch<6; ch++) p->fm_mod[ch] = 0xff;
  for (uint8_t v = 0; v < MMLP_VOICES; v++) {
    p->shift[v] = 0xff;
    p->page[v] = 0xff;
    p->since_gen[v] = 0xff;
  }
}

/* The producer fills from its own cursor (q_work) and publishes q_head once,
 * at the end of a frame: an interrupt-side grab sees all of a frame's pairs or
 * none of them, never a pitch pair's upper half without its lower. */
MMLP_HOT void push(MMLPairs *p, uint8_t port, uint8_t op, uint8_t val) {
  uint16_t next = (uint16_t)((p->q_work + 1) & (MMLP_QUEUE - 1));
  if (next == p->q_tail) { p->overflow++; return; }
  p->q_port[p->q_work] = port;
  p->q_op[p->q_work] = op;
  p->q_val[p->q_work] = val;
  p->q_work = next;
}
/* Into the PCM lane (mmlpairs.h): the state stores, and $2B. */
MMLP_HOT void lane(MMLPairs *p, uint8_t port, uint8_t op, uint8_t val) {
  uint16_t next = (uint16_t)((p->l_work + 1) & (MMLP_LANE - 1));
  if (next == p->l_tail) { p->overflow++; return; }
  p->l_port[p->l_work] = port;
  p->l_op[p->l_work] = op;
  p->l_val[p->l_work] = val;
  p->l_work = next;
}
MMLP_HOT void store(MMLPairs *p, uint8_t op, uint8_t val) {
  if (p->cfg.banked) push(p, 0xff, op, val); else lane(p, 0xff, op, val);
}

/* A port-0 write, into the FM queue — or the lane for the DAC enable. */
MMLP_HOT void push0(MMLPairs *p, uint8_t addr, uint8_t data) {
  if (addr == 0x2b && !p->cfg.banked) lane(p, 0, addr, data);
  else push(p, 0, addr, data);
}

uint16_t mmlp_pending(const MMLPairs *p) {
  return (uint16_t)(((p->q_head + MMLP_QUEUE - p->q_tail) & (MMLP_QUEUE - 1))
                    + ((p->l_head + MMLP_LANE - p->l_tail) & (MMLP_LANE - 1)));
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
  case 6:
  case PCM_START: {
    uint8_t v = c[1];
    if (v >= cfg->voices) { p->fault++; return; }
    if (c[0] == 6 && (v > 2 || (v == 2 && rd16le(c + 9) > 127))) { p->fault++; return; }
    p->shift[v] = c[2];
    level(p, v);
    /* ONLY WHAT CHANGED. The staged bytes are the host's alone (the engine reads
     * them at the edge and never writes them), so the block still holds the last
     * values: a drum hit on the same sample is one pair, not eight. */
    const uint16_t src = rd16le(c + 3), end = rd16le(c + 5), wrap = rd16le(c + 7);
    const uint8_t vals[6] = {(uint8_t)src, (uint8_t)(src >> 8), (uint8_t)end, (uint8_t)(end >> 8),
                             (uint8_t)wrap, (uint8_t)(wrap >> 8)};
    stage(p, v, 0, vals, 6);
    if (c[0] == 6) {
      uint16_t bank = rd16le(c + 9);
      if (!p->bank_valid[v] || p->bank[v] != bank) {
        store(p, v == 2 ? 0x21 : (uint8_t)(0x1c + 2*v), (uint8_t)bank);
        if (v != 2) store(p, (uint8_t)(0x1d + 2*v), (uint8_t)(bank >> 8));
        p->bank[v] = bank; p->bank_valid[v] = 1;
      }
    }
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

static void frame_begin(MMLPairs *p) {
  p->q_work = p->q_head;
  p->l_work = p->l_head;
  p->psg_work = p->psg_head;
}

/* The publication: this frame's ends first, then the heads, then the frame
 * count — one 16-bit store each. A grab bounds itself by the ends of the
 * frames it may send, never by the heads, so it cannot see this frame until
 * frames_in says it exists. */
static void frame_publish(MMLPairs *p) {
  p->end_q[p->frames_in & (MMLP_FRAMES - 1)] = p->q_work;
  p->end_psg[p->frames_in & (MMLP_FRAMES - 1)] = p->psg_work;
  p->end_l[p->frames_in & (MMLP_FRAMES - 1)] = p->l_work;
  p->psg_head = p->psg_work;
  p->l_head = p->l_work;
  p->q_head = p->q_work;
  p->frames_in = (uint16_t)(p->frames_in + 1);
}

/* The bytes a run of `npcm` PCM commands takes, or 0xffff when it is
 * malformed or overruns `len`. */
static uint16_t pcm_size(const uint8_t *c, uint16_t len, uint8_t npcm) {
  uint16_t i = 0;
  for (; npcm > 0; npcm--) {
    const uint8_t op = i < len ? c[i] : 0;
    if (op > 6 || !PCM_LEN[op] || (uint16_t)(i + PCM_LEN[op]) > len) return 0xffff;
    i = (uint16_t)(i + PCM_LEN[op]);
  }
  return i;
}

/* A frame's PCM commands (a run pcm_size accepted), into the lane after the
 * frame's $2B. */
static void pcm_run(MMLPairs *p, const uint8_t *c, uint8_t npcm) {
  for (; npcm > 0; npcm--) {
    pcm_command(p, c);
    c += PCM_LEN[c[0]];
  }
}

MMLP_HOT void psg_push(MMLPairs *p, uint8_t b) {
  uint16_t next = (uint16_t)((p->psg_work + 1) & (MMLP_PSG - 1));
  if (next != p->psg_tail) { p->psg[p->psg_work] = b; p->psg_work = next; }
}

/* A frame's register writes, n of them in the order the sequencer made them,
 * write i at base + ((first + i) & mask) * stride as {port, addr, data}.
 *
 * PORT 1 WAITS, PORT 0 AND THE PSG DO NOT — one port switch a frame instead of
 * one per channel change — EXCEPT AT AN fm4-6 KEY EDGE. $28 is a port-0
 * register for every channel, while fm4-6's F-number, level and patch are
 * port 1; the sequencer writes a note's pitch before its key-on, and a key-on
 * moved ahead of that pitch attacks at the previous note's (372 times on the
 * c-gate corpus when every port-1 write waited for the frame's end). So a $28
 * that names ch4-6 first sends the port-1 writes made before it. Everything
 * else only ever moves port 1 later, which the two ports' disjoint channels
 * make safe. The JS twin is tools/pairs-model.mjs frame(). */
MMLP_HOT void port1_run(MMLPairs *p, const uint8_t *base, uint16_t first, uint16_t lo, uint16_t hi,
                        uint16_t mask, uint16_t stride) {
  for (uint16_t i = lo; i < hi; i++) {
    const uint8_t *w = base + (uint16_t)((first + i) & mask) * stride;
    if (w[0] == 1) push(p, 1, w[1], w[2]);
  }
}
MMLP_HOT void writes_body(MMLPairs *p, const uint8_t *base, uint16_t first, uint16_t n,
                          uint16_t mask, uint16_t stride) {
  uint16_t lo = n, hi = 0;   /* the port-1 writes not yet sent: first and last + 1 */
  for (uint16_t i = 0; i < n; i++) {
    const uint8_t *w = base + (uint16_t)((first + i) & mask) * stride;
    if (w[0] == 2) psg_push(p, w[2]);
    else if (w[0] == 0) {
      if (w[1] == 0x28 && (w[2] & 4) && lo < n) {
        port1_run(p, base, first, lo, hi, mask, stride);
        lo = n;
      }
      push0(p, w[1], w[2]);
    } else {
      if (lo == n) lo = i;
      hi = (uint16_t)(i + 1);
    }
  }
  if (lo < n) port1_run(p, base, first, lo, hi, mask, stride);
}

/* Ordinary independent FM channels may move ahead of bulk patch uploads.
 * Keep each channel's writes and complete pitch-latch pairs in order. */
MMLP_HOT uint8_t fm_channel(const MMLWrite *w) {
  if (w->port > 1) return 0xff;
  if (w->port == 0 && w->addr == 0x28 && (w->data & 3) < 3)
    return (uint8_t)((w->data & 3) + ((w->data & 4) ? 3 : 0));
  if (((w->addr >= 0x30 && w->addr <= 0x9e) ||
       (w->addr >= 0xa0 && w->addr <= 0xa6) || (w->addr >= 0xb0 && w->addr <= 0xb6)) && (w->addr & 3) < 3)
    return (uint8_t)(3*w->port + (w->addr & 3));
  return 0xff;
}
MMLP_HOT const MMLWrite *view_write(const MMLFrameView *v, uint16_t i) {
  return &v->q[(v->first+i) & (MML_WRITE_QUEUE-1)];
}
static void banked_writes(MMLPairs *p, const MMLFrameView *v) {
  uint16_t n=v->end[MML_SLOT_SUBS-1], counts[6]={0,0,0,0,0,0};
  uint8_t eligible=0, moved=0, intermediate=0, previous[6];
  int safe=1;
  for (uint8_t ch=0; ch<6; ch++) previous[ch]=p->fm_mod[ch];
  for (uint16_t i=0; i<n; i++) {
    const MMLWrite *w=view_write(v,i); uint8_t ch=fm_channel(w);
    if (ch<6) counts[ch]++;
    if (w->port>1) continue;
    if (w->addr>=0xb4 && w->addr<=0xb6) {
      uint8_t m=w->data & 0x37; p->fm_mod[3*w->port+(w->addr&3)]=m;
      if (m) intermediate |= (uint8_t)(1u << (3*w->port+(w->addr&3)));
    }
    if (w->addr<0x30 && w->addr!=0x22 && w->addr!=0x24 && w->addr!=0x25 &&
        w->addr!=0x26 && w->addr!=0x27 && w->addr!=0x28 && w->addr!=0x2b) safe=0;
    if (w->addr>=0xa4 && w->addr<=0xa6 && (i+1>=n || view_write(v,i+1)->port!=w->port || view_write(v,i+1)->addr!=w->addr-4)) safe=0;
    if (w->addr>=0xa0 && w->addr<=0xa2 && (!i || view_write(v,i-1)->port!=w->port || view_write(v,i-1)->addr!=w->addr+4)) safe=0;
  }
  if (safe) for (uint8_t ch=0; ch<6; ch++)
    if (ch!=2 && ch!=5 && counts[ch] && counts[ch]<=8 && previous[ch]==0 && p->fm_mod[ch]==0 && !(intermediate&(1u<<ch))) eligible |= (uint8_t)(1u<<ch);
  /* Smallest group first, ties in channel order. */
  for (uint8_t size=1; size<=8; size++) for (uint8_t ch=0; ch<6; ch++)
    if ((eligible&(1u<<ch)) && counts[ch]==size) {
      for (uint16_t i=0; i<n; i++) {
        const MMLWrite *w=view_write(v,i);
        if (fm_channel(w)==ch) { if (w->port==0) push0(p,w->addr,w->data); else push(p,1,w->addr,w->data); }
      }
      moved |= (uint8_t)(1u<<ch);
    }
  /* Remaining writes keep the legacy port-1 deferral and key-edge rule. */
  uint16_t lo=n, hi=0;
  for (uint16_t i=0; i<=n; i++) {
    const MMLWrite *w=i<n ? view_write(v,i) : 0;
    if (moved && w) {
      const uint8_t ch=fm_channel(w);
      if (ch<6 && (moved&(1u<<ch))) continue;
    }
    if (!w || (w->port==0 && w->addr==0x28 && (w->data&4))) {
      for (uint16_t k=lo; k<hi; k++) {
        const MMLWrite *other=view_write(v,k);
        if (other->port==1) {
          uint8_t ch=moved ? fm_channel(other) : 0xff;
          if (!(ch<6 && (moved&(1u<<ch)))) push(p,1,other->addr,other->data);
        }
      }
      lo=n; hi=0;
    }
    if (!w) break;
    if (w->port==2) psg_push(p,w->data);
    else if (!w->port) push0(p,w->addr,w->data);
    else { if (lo==n) lo=i; hi=i+1; }
  }
}

/* THE SGDK HOST'S FRAME, straight from the sequencer's queue (mmlispseq.h
 * MMLFrameView): its writes, then its PCM commands into the lane. */
static void view_body(MMLPairs *p, const MMLFrameView *v) {
  if (p->cfg.banked) {
    uint16_t count = v->end[MML_SLOT_SUBS - 1];
    int short_note = 1;
    int global = 0;
    uint16_t fm_count = 0;
    for (uint16_t i=0; i<count; i++) {
      const MMLWrite *w = &v->q[(v->first + i) & (MML_WRITE_QUEUE - 1)];
      if (w->port != 2) fm_count++;
      if (w->port != 2 && w->addr < 0x30 && w->addr != 0x28) { short_note = 0; global = 1; }
    }
    short_note = short_note && fm_count <= 8;
    if (!short_note && !global && pcm_size(v->pcm, v->pcm_len, v->pcm_count) != 0xffff)
      pcm_run(p, v->pcm, v->pcm_count);
    banked_writes(p, v);
    if ((short_note || global) && pcm_size(v->pcm, v->pcm_len, v->pcm_count) != 0xffff)
      pcm_run(p, v->pcm, v->pcm_count);
    return;
  }
  writes_body(p, (const uint8_t *)v->q, v->first, v->end[MML_SLOT_SUBS - 1],
              MML_WRITE_QUEUE - 1, (uint16_t)sizeof(MMLWrite));
  /* The PCM commands go into the lane after the writes, so a $2B the frame
   * turned the DAC on with leads its first start. */
  if (pcm_size(v->pcm, v->pcm_len, v->pcm_count) != 0xffff) pcm_run(p, v->pcm, v->pcm_count);
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

/* The same frame from its record bytes (mmlpairs.h) — the gates' path. */
void mmlp_frame(MMLPairs *p, const uint8_t *rec, uint16_t len) {
  frame_begin(p);
  if (len >= 1) {
    /* The PCM run is measured first and taken last, as view_body does. */
    const uint16_t used = pcm_size(rec + 1, (uint16_t)(len - 1), rec[0]);
    if (used != 0xffff) {
      const uint16_t at = (uint16_t)(1 + used);
      writes_body(p, rec + at, 0, (uint16_t)((len - at) / 3), 0xffff, 3);
      pcm_run(p, rec + 1, rec[0]);
    }
  }
  frame_publish(p);
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

/* The queues wrap with a mask (an int `%` is a libgcc call on the 68000). */
typedef char mmlp_queue_is_pow2[(MMLP_QUEUE & (MMLP_QUEUE - 1)) == 0 && (MMLP_PSG & (MMLP_PSG - 1)) == 0
                                && (MMLP_LANE & (MMLP_LANE - 1)) == 0 ? 1 : -1];

MMLP_HOT int is_pitch_hi(uint8_t reg) { return (uint8_t)((reg & 0xf7) - 0xa4) <= 2; } /* $A4-$A6, $AC-$AE */
/* A state op's voice and its place in the voice's nine (op - 1 = 9v + k), as
 * tables: `% 9` and `/ 9` on an int are libgcc calls on the 68000. */
static const uint8_t OP_VOICE[1 + 9 * MMLP_VOICES] = {
  0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2 };
static const uint8_t OP_K[1 + 9 * MMLP_VOICES] = {
  0xff, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8 };
/* The voice a staged store (SRC, END, WRAP) belongs to, or 0xff. */
MMLP_HOT uint8_t staged_voice(const MMLPairsCfg *cfg, uint8_t op) {
  if (cfg->banked && op == 0x21) return 2;
  if (cfg->banked && op >= 0x1c && op <= 0x1f) return (uint8_t)((op - 0x1c) >> 1);
  if (op == 0 || op >= (uint8_t)(1 + 9 * cfg->voices)) return 0xff;
  const uint8_t k = OP_K[op];
  return k >= 1 && (k <= 6 || cfg->banked) ? OP_VOICE[op] : 0xff;
}
/* The voice a generation pair (START, RETARGET) belongs to, or 0xff. */
MMLP_HOT uint8_t gen_voice(const MMLPairsCfg *cfg, uint8_t op) {
  if (op == 0 || op >= (uint8_t)(1 + 9 * cfg->voices)) return 0xff;
  return OP_K[op] >= 7 ? OP_VOICE[op] : 0xff;
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
  const uint16_t llim = avail ? p->end_l[(avail - 1) & (MMLP_FRAMES - 1)] : p->l_tail;
  const uint8_t N = cfg->fifo_pairs, MASK = (uint8_t)(N - 1);
  p->grabs++;
  p->undo_tail = p->q_tail;
  p->undo_ltail = p->l_tail;
  p->undo_port = p->chip_port;
  for (uint8_t v = 0; v < MMLP_VOICES; v++) p->undo_since[v] = p->since_gen[v];
  p->undo_n = 0;
  /* WHERE THE PAIRS GO (pairs-model.mjs twins this): ahead of the index read last time by
   * more than the consumer takes between grabs — and never behind the pairs
   * written last time that it may not have reached yet. */
  if (fifo_lo == 0xff) { *dst = 0; return 0; }            /* no index yet */
  if (cfg->banked && p->head_valid && p->last_fifo != 0xff &&
      (uint8_t)(fifo_lo - p->last_fifo) >= (uint8_t)(2*p->head - p->last_fifo)) p->head_valid = 0;
  p->last_fifo = fifo_lo;
  p->undo_head = p->head; p->undo_head_valid = p->head_valid;
  uint8_t c = (uint8_t)((fifo_lo >> 1) & MASK);
  uint8_t h = (uint8_t)((c + (cfg->ahead ? cfg->ahead : MMLP_AHEAD)) & MASK);
  if (p->head_valid) {
    uint8_t d_old = (uint8_t)((p->head - c) & MASK);
    uint8_t d_new = (uint8_t)((h - c) & MASK);
    if (d_old > d_new && (cfg->banked || d_old < 64)) h = p->head;
  }
  /* A grab writes pairs_per_grab pairs, always — the real ones, then IDLE —
   * and never across the page end. So a head too near the end moves to 0: the
   * few pairs skipped are idle, and the engine reads them before position 0,
   * so nothing is read out of order. */
  if ((uint16_t)h + cfg->pairs_per_grab > N) {
    /* Wrapping must not jump backwards into earlier unread transfers. A late
     * copy at that destination would otherwise discard the pending head. */
    if (cfg->banked && ((N-c)&MASK) < ((h-c)&MASK)) {
      *dst = (uint16_t)(cfg->fifo + 2*h);
      return 0;
    }
    h = 0;
  }
  p->head = h;
  p->head_valid = 1;
  uint16_t n = 0;
  /* A physical grab also writes its IDLE padding. Reserve the whole grab,
   * otherwise a short plan near a full ring overwrites unread commands. */
  if (cfg->banked && (uint16_t)(((p->head - c) & MASK) + cfg->pairs_per_grab) > N) {
    *dst = (uint16_t)(cfg->fifo + 2*p->head);
    return 0;
  }
  while (n < cfg->pairs_per_grab) {
    /* THE LANE FIRST: every released PCM pair goes before any FM pair. */
    const int from_lane = p->l_tail != llim;
    if (!from_lane && p->q_tail == lim) break;
    const uint16_t t = from_lane ? p->l_tail : p->q_tail;
    const uint8_t port = from_lane ? p->l_port[t] : p->q_port[t];
    const uint8_t op = from_lane ? p->l_op[t] : p->q_op[t];
    const uint8_t val = from_lane ? p->l_val[t] : p->q_val[t];
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
    const int pitch = !from_lane && port != 0xff && is_pitch_hi(op);
    if (pitch) need++;                                     /* the lower half rides along */
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
    if (from_lane) p->l_tail = (uint16_t)((t + 1) & (MMLP_LANE - 1));
    else p->q_tail = (uint16_t)((t + 1) & (MMLP_QUEUE - 1));
    if (pitch && p->q_tail != lim) {
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
  p->l_tail = p->undo_ltail;
  p->chip_port = p->undo_port;
  for (uint8_t v = 0; v < MMLP_VOICES; v++) p->since_gen[v] = p->undo_since[v];
  p->pairs_written = (uint16_t)(p->pairs_written - p->undo_n);
  p->undo_n = 0;
  if (p->cfg.banked) { p->head = p->undo_head; p->head_valid = p->undo_head_valid; }
  else p->head_valid = 0;
  p->late++;
}

uint16_t mmlp_psg_take(MMLPairs *p, uint16_t release, uint8_t *out, uint16_t max) {
  uint16_t n = 0;
  if (p->cfg.banked) {
    const uint16_t now = released(p, release);
    if (now) p->psg_mark = p->end_psg[(now - 1) & (MMLP_FRAMES - 1)];
  }
  while (p->psg_tail != p->psg_mark && n < max) {
    out[n++] = p->psg[p->psg_tail];
    p->psg_tail = (uint16_t)((p->psg_tail + 1) & (MMLP_PSG - 1));
  }
  const uint16_t avail = released(p, release);
  if (avail) p->psg_mark = p->end_psg[(avail - 1) & (MMLP_FRAMES - 1)];
  return n;
}
