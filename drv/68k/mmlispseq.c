/* MMLispDRV sequencer — 68000 half of the split (docs/driver.md §4).
 *
 * Ported from live/src/drv-player.js, which is the normative spec: the gate
 * (tools/c-gate.mjs) diffs the two slot streams at zero tolerance. Comments
 * here explain *why* a rule exists; the JS carries the same reasoning.
 */
#include "mmlispseq.h"

/* No libc. `memset`/`memcpy` would be the only calls, and reaching for them
 * costs more than they are worth here: SGDK's <string.h> is not standalone-
 * includable (it types its prototypes with SGDK's own u16/s8 and assumes
 * <types.h> came first), and its memcpy has a different signature from the
 * standard one, so a local declaration would clash. Two loops keep this file
 * exactly as freestanding as its header comment claims. */
static void mml_zero(void *dst, uint32_t n) {
  uint8_t *p = (uint8_t *)dst;
  while (n--) *p++ = 0;
}
static void mml_copy(uint8_t *dst, const uint8_t *src, uint16_t n) {
  while (n--) *dst++ = *src++;
}

#define MAGIC0 0x4d
#define MAGIC1 0x4d
#define MAGIC2 0x42
#define MAGIC3 0x30
#define SEC_TRACK_TABLE 0x0001
#define SEC_EVENT_STREAM 0x0002
#define SEC_VAL_TABLE 0x0005
#define SEC_VOICE_TABLE 0x0006
#define SEC_MACRO_TABLE 0x0007
#define TRACK_FLAG_IS_CSM 0x02

/* PCM command opcodes (driver.md §6.3; slot-builder.js is the definition). */
#define PCM_START 1
#define PCM_STOP 2
#define PCM_VOL 3

/* Channel ids beyond the 10 register channels (mmb.md §6.1). */
#define CH_PCM1 20
#define CH_PCM3 22

#define DUR_HOLD 0x00
#define DUR_EXT 0xff
#define VOL_UNITY 31

/* Opcodes (opcodes.md) */
enum {
  OP_END_OF_TRACK = 0x00,
  OP_NOTE_ON = 0x10,
  OP_REST = 0x11,
  OP_TIE = 0x12,
  OP_NOTE_ON_EX = 0x13,
  OP_VOICE_SET = 0x14,
  OP_LOOP_BEGIN = 0x40,
  OP_LOOP_END = 0x41,
  OP_MARKER = 0x42,
  OP_JUMP = 0x43,
  OP_CALL = 0x44,
  OP_RET = 0x45,
  OP_LOOP_BREAK = 0x46,
  OP_PARAM_SET = 0x60,
  OP_PARAM_SWEEP = 0x61,
  OP_PARAM_ADD = 0x62,
  OP_PARAM_MUL = 0x63,
  OP_PARAM_FROM_VAL = 0x64,
  OP_PARAM_SWEEP_STOP = 0x65,
  OP_TEMPO_SET = 0x80,
  OP_TEMPO_SWEEP = 0x81,
  OP_CSM_ON = 0xa0,
  OP_CSM_OFF = 0xa1,
  OP_CSM_RATE = 0xa2,
  OP_FM3_MODE = 0xa3,
  OP_FM3_OP_PITCH = 0xa4,
  OP_PCM_NOTE_ON = 0xc0,
  OP_PCM_NOTE_OFF = 0xc1,
  OP_MACRO_SET = 0xe0,
  OP_PARAM_ADD_VAL = 0xe1,
  OP_PARAM_MUL_VAL = 0xe2,
  OP_MACRO_CLEAR = 0xe3
};

/* Target ids (opcodes.md §7) */
enum {
  T_NOTE_PITCH = 0x01,
  T_TEMPO_SCALE = 0x03,
  T_VOL = 0x04,
  T_MASTER = 0x05,
  T_VEL = 0x06,
  T_NOTE_SEMI = 0x07,
  T_KEYON = 0x08,
  T_GATE = 0x09,
  T_FM_FB = 0x10,
  T_FM_TL1 = 0x11,
  T_FM_ALG = 0x15,
  T_FM_AR1 = 0x16,
  T_FM_DR1 = 0x1a,
  T_FM_SR1 = 0x1e,
  T_FM_RR1 = 0x22,
  T_FM_SL1 = 0x26,
  T_FM_KS1 = 0x2a,
  T_FM_ML1 = 0x2e,
  T_FM_DT1 = 0x32,
  T_FM_SSG1 = 0x36,
  T_FM_AMEN1 = 0x3a,
  T_FM_AMEN4 = 0x3d,
  T_FM_AMS = 0x3e,
  T_FM_FMS = 0x3f,
  T_PAN = 0x40,
  T_LFO_RATE = 0x41,
  T_NOISE_MODE = 0x42
};

static uint16_t rd16(const uint8_t *b, uint32_t o) {
  return (uint16_t)(b[o] | (b[o + 1] << 8));
}
static uint32_t rd32(const uint8_t *b, uint32_t o) {
  return (uint32_t)b[o] | ((uint32_t)b[o + 1] << 8) | ((uint32_t)b[o + 2] << 16) |
         ((uint32_t)b[o + 3] << 24);
}
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ── Write paths ───────────────────────────────────────────────────────────
 * Everything the sequencer emits lands in the slot queue. $2A and $2B are the
 * exception: post-split they belong to the mixer, which is the only thing that
 * knows when a voice is sounding (driver.md §14). They still update the shadow
 * — an unwritten shadow entry would let a later write of 0 be suppressed — but
 * they never cross the bus.
 */
static void q_push(MMLSeq *s, uint8_t port, uint8_t addr, uint8_t data) {
  if (port == 0 && (addr == 0x2a || addr == 0x2b)) return;
  uint16_t next = (uint16_t)((s->q_head + 1) % MML_WRITE_QUEUE);
  if (next == s->q_tail) return; /* queue full: cannot happen on real scores */
  s->q[s->q_head].port = port;
  s->q[s->q_head].addr = addr;
  s->q[s->q_head].data = data;
  s->q_head = next;
}

/* YM parameter write, change-only through the shadow. */
static void ym(MMLSeq *s, uint8_t port, uint8_t addr, uint8_t data) {
  if (s->shadow_set[port][addr] && s->shadow[port][addr] == data) return;
  s->shadow_set[port][addr] = 1;
  s->shadow[port][addr] = data;
  q_push(s, port, addr, data);
}

/* YM write that always emits but keeps the shadow current. For the F-number
 * pair $A4-A6/$A0-A2: the high byte latches into a register the chip shares
 * across a port's three channels and the low byte commits {latch, low} to one
 * of them, so suppressing the high byte would let another channel's
 * intervening write pick the wrong octave (driver.md §8). */
static void ym_always(MMLSeq *s, uint8_t port, uint8_t addr, uint8_t data) {
  s->shadow_set[port][addr] = 1;
  s->shadow[port][addr] = data;
  q_push(s, port, addr, data);
}

/* $28 is a key EDGE, not state. */
static void ym_key(MMLSeq *s, uint8_t data) { q_push(s, 0, 0x28, data); }

/* The SN76489 has no readable state; its bytes always go out. */
static void psg_byte(MMLSeq *s, uint8_t byte) { q_push(s, 2, 0, byte); }

/* ── PCM command emission (driver.md §6.3) ─────────────────────────────────
 * Every field is resolved HERE: the engine receives register-ready values and
 * does no per-note arithmetic at all. Commands are appended to the frame's PCM
 * run in order; unlike register writes they are never capped, because a
 * deferred PCM_START would mean a note that simply did not play.
 */
static void pcm_emit(MMLSeq *s, const uint8_t *bytes, uint16_t n) {
  if (s->pcm_len + n > MML_SLOT_SIZE) return; /* cannot happen: 3 voices max */
  for (uint16_t i = 0; i < n; i++) s->pcm_buf[s->pcm_len++] = bytes[i];
  s->pcm_count++;
}

/* MUTE_SHIFT (8) is a real table entry in the mixer: a muted voice keeps
 * advancing and contributes nothing, matching FM where a note continues
 * silently under a 0 fader (driver.md §14). */
static uint8_t pcm_shift_byte(const MMLPcmVoice *v) {
  return (uint8_t)(v->muted ? 8 : v->shift);
}

static void emit_pcm_start(MMLSeq *s, int vi, const MMLPcmVoice *v) {
  /* The sample bank is bank-relative; the engine wants {ROM bank, window
   * address} because that is what its $8000-window mapper takes. */
  uint32_t abs = v->base;
  uint8_t inc_i = (uint8_t)((v->inc >> 16) & 0xff);
  /* 2^ksh >= the largest advance one tick can make, so the engine bounds a
   * segment with a shift instead of a division. That is the bit length of the
   * integer part: ceil(log2(inc_i + 1)). */
  uint8_t ksh = 0;
  while ((1u << ksh) < (uint32_t)inc_i + 1u) ksh++;
  uint16_t bank = (uint16_t)(abs >> 15), addr = (uint16_t)(0x8000 + (abs & 0x7fff));
  uint8_t c[18];
  c[0] = PCM_START;
  c[1] = (uint8_t)vi;
  c[2] = (uint8_t)(1 | (v->has_loop ? 2 : 0));
  c[3] = pcm_shift_byte(v);
  c[4] = ksh;
  c[5] = (uint8_t)(bank & 0xff);
  c[6] = (uint8_t)(bank >> 8);
  c[7] = (uint8_t)(addr & 0xff);
  c[8] = (uint8_t)(addr >> 8);
  c[9] = (uint8_t)(v->left & 0xff);
  c[10] = (uint8_t)((v->left >> 8) & 0xff);
  c[11] = (uint8_t)(v->loop_len & 0xff);
  c[12] = (uint8_t)((v->loop_len >> 8) & 0xff);
  c[13] = (uint8_t)(v->tail & 0xff);
  c[14] = (uint8_t)((v->tail >> 8) & 0xff);
  c[15] = (uint8_t)(v->inc & 0xff);
  c[16] = (uint8_t)((v->inc >> 8) & 0xff);
  c[17] = inc_i;
  pcm_emit(s, c, 18);
}

/* vel + vol + master compose to a per-voice bit shift the mixer applies as an
 * arithmetic right shift — one instruction per sample, which is the whole
 * reason the level model is a shift here and a TL offset on FM:
 *   n = (15-vel) + (31-vol) + (31-master);  shift = min(7, round(n/3)).
 * vol == 0 or master == 0 is a hard mute; vel alone never mutes. Once per
 * PARAM_SET, so the divide is nowhere near the mix path. */
static void pcm_compose_shift(MMLSeq *s, int vi) {
  MMLPcmVoice *v = &s->pcm[vi];
  v->muted = (uint8_t)(v->vol == 0 || s->master == 0);
  int n = (15 - v->vel) + (31 - v->vol) + (31 - s->master);
  int shift = (n + 1) / 3; /* round(n/3); n is never negative */
  v->shift = (uint8_t)(shift > 7 ? 7 : shift);
  uint8_t byte = pcm_shift_byte(v);
  /* A dead voice has nothing to re-level: the engine dropped its state. */
  if (v->active && byte != v->sent_shift) {
    v->sent_shift = byte;
    uint8_t c[3] = {PCM_VOL, (uint8_t)vi, byte};
    pcm_emit(s, c, 3);
  }
}

/* ── Register encoders (ir-utils.js) ───────────────────────────────────────── */
static uint8_t enc_b0(const MMLFmCh *c) {
  return (uint8_t)(((c->feedback & 7) << 3) | (c->algorithm & 7));
}
static uint8_t enc_b4(const MMLFmCh *c) {
  uint8_t pan = c->pan < 0 ? 2 : c->pan > 0 ? 1 : 3;
  return (uint8_t)((pan << 6) | ((c->ams & 3) << 4) | (c->fms & 7));
}
static uint8_t enc_30(const MMLOp *o) {
  return (uint8_t)(((o->dt & 7) << 4) | (o->mul & 0x0f));
}
static uint8_t enc_60(const MMLOp *o) {
  return (uint8_t)(((o->amen & 1) << 7) | (o->dr & 0x1f));
}
static uint8_t enc_80(const MMLOp *o) {
  return (uint8_t)(((o->sl & 0x0f) << 4) | (o->rr & 0x0f));
}

/* ── Curves and sweeps (driver.md §4 step 3) ───────────────────────────────
 * Integer-only and single-sourced: mmb.js curveUnit8 is THE definition, and
 * both this and the Z80 are hand-ports of it, so the three cannot disagree.
 * Ids 0-3 are one-shot easings, 4-7 periodic loop shapes. */
static int curve_unit8(int id, int t) {
  t &= 0xff;
  switch (id) {
    case 1: return (t * t) >> 8;                                  /* ease-in  */
    case 2: return 255 - (((255 - t) * (255 - t)) >> 8);          /* ease-out */
    case 3: return t < 128 ? (2 * t * t) >> 8
                           : 255 - ((2 * (255 - t) * (255 - t)) >> 8);
    case 4: return MML_SIN_LUT[t];
    case 5: return t < 128 ? t << 1 : (255 - t) << 1;             /* triangle */
    case 6: return t < 128 ? 0 : 255;                             /* square   */
    default: return t;                                            /* linear/saw */
  }
}
/* from + trunc((to-from)*unit/256) — truncating TOWARD ZERO, which is what
 * the Z80's sign-magnitude shift does. */
static int sweep_value(int from, int to, int unit8) {
  int p = (to - from) * (unit8 & 0xff);
  return from + (p < 0 ? -((-p) >> 8) : p >> 8);
}
static uint16_t sweep_step(int len, int loop) {
  int n = len < 1 ? 1 : len;
  long v;
  if (loop) v = 65536L / n;
  else if (n <= 1) return 0;
  else v = 65536L / (n - 1);
  return (uint16_t)(v > 0xffff ? 0xffff : v);
}

/* ── Level model (driver.md §7) ────────────────────────────────────────────
 * Offsets are stored in quarter steps and summed before a single rounding, so
 * the runtime stays integer-only while landing inside the documented band. */
static uint8_t carrier_tl(const MMLSeq *s, uint8_t voiced_tl, uint8_t vel, uint8_t vol) {
  int off4 = MML_VEL_TL4[vel] + MML_VOL_TL4[vol] + MML_VOL_TL4[s->master];
  int tl = voiced_tl + ((off4 + (off4 >= 0 ? 2 : -2)) >> 2);
  return (uint8_t)clampi(tl, 0, 127);
}
static uint8_t psg_att(const MMLSeq *s, uint8_t vel, uint8_t vol) {
  if (vol == 0 || s->master == 0) return 15; /* hard mute (language.md §6) */
  int off4 = MML_VEL_PSG4[vel] + MML_VOL_PSG4[vol] + MML_VOL_PSG4[s->master];
  int att = (off4 + (off4 >= 0 ? 2 : -2)) >> 2;
  return (uint8_t)clampi(att, 0, 15);
}

/* ── Pitch (driver.md §8) ─────────────────────────────────────────────────── */
static void fold_cents(int *note, int *cents) {
  int whole = *cents / 100; /* C truncates toward zero, like Math.trunc */
  *note += whole;
  *cents -= whole * 100;
  if (*cents < 0) {
    *note -= 1;
    *cents += 100;
  }
  *note = clampi(*note, 0, 126);
}
static uint16_t fnum_block_for(int note, int cents) {
  fold_cents(&note, &cents);
  if (cents == 0) return MML_FNUM_BLOCK[note];
  uint16_t e0 = MML_FNUM_BLOCK[note], e1 = MML_FNUM_BLOCK[note + 1];
  int block = e0 >> 11, fnum0 = e0 & 0x7ff;
  int shift = (e1 >> 11) - block;
  if (shift < 0) shift = 0; /* 0 or 1 for adjacent notes */
  int v1 = (e1 & 0x7ff) << shift; /* e1's F-number in block0 units */
  int fnum = fnum0 + ((v1 - fnum0) * cents + 50) / 100; /* round half up */
  while (fnum > 1023 && block < 7) {
    block++;
    fnum >>= 1;
  }
  return (uint16_t)(((block & 7) << 11) | (fnum & 0x7ff));
}
static uint16_t psg_period_for(int note, int cents) {
  fold_cents(&note, &cents);
  if (cents == 0) return MML_PSG_PERIOD[note];
  /* Period falls as pitch rises, so the numerator stays non-negative — the
   * same form the asm uses, which is what keeps all three players bit-equal. */
  int p0 = MML_PSG_PERIOD[note];
  int diff = p0 - MML_PSG_PERIOD[note + 1];
  int p = p0 - (diff * cents + 50) / 100;
  return (uint16_t)clampi(p, 1, 1023);
}

static void write_fm_pitch(MMLSeq *s, int ch, int note, int cents) {
  uint8_t port = ch >= 3 ? 1 : 0, off = (uint8_t)(ch % 3);
  uint16_t fb = fnum_block_for(note, cents);
  ym_always(s, port, (uint8_t)(0xa4 + off),
            (uint8_t)((((fb >> 11) & 7) << 3) | ((fb >> 8) & 7)));
  ym_always(s, port, (uint8_t)(0xa0 + off), (uint8_t)(fb & 0xff));
}
static void write_psg_pitch(MMLSeq *s, int pc, int note, int cents) {
  uint16_t p = psg_period_for(note, cents);
  psg_byte(s, (uint8_t)(0x80 | ((pc & 3) << 5) | (p & 0x0f)));
  psg_byte(s, (uint8_t)((p >> 4) & 0x3f));
}
static void write_psg_att(MMLSeq *s, int pc, uint8_t att) {
  s->psg[pc].sounding = (att & 0x0f) < 15;
  psg_byte(s, (uint8_t)(0x90 | ((pc & 3) << 5) | (att & 0x0f)));
}
static void write_noise_cfg(MMLSeq *s) {
  psg_byte(s, (uint8_t)(0x80 | (3 << 5) | (s->noise_mode & 7)));
}

/* ── FM3 independent-OP mode (driver.md §5.1, opcodes 0xA3/0xA4) ───────────
 * In CH3 special mode ($27 bit6) the channel's four operators carry independent
 * F-numbers and key bits. op1 rides channel 2 (fm3); op2-4 ride channels 16-18.
 * Returns the 1-based operator, or 0 when this channel is an ordinary one. */
static int fm3_op_for(const MMLSeq *s, int ch) {
  if (!(s->reg27 & 0x40)) return 0;
  if (ch == 2) return 1;
  if (ch >= 16 && ch <= 18) return ch - 14;
  return 0;
}
static void fm3_key_op(MMLSeq *s, int op, int on) {
  uint8_t bit = (uint8_t)(0x10 << (op - 1)); /* OP1=0x10 .. OP4=0x80 */
  if (on) s->fm3_op_mask |= bit;
  else s->fm3_op_mask &= (uint8_t)~bit;
  ym_key(s, (uint8_t)(s->fm3_op_mask | 0x02)); /* ch2 key = 0x02 */
}
static void write_fm3_op_pitch(MMLSeq *s, int op, int note) {
  uint16_t fb = fnum_block_for(note, 0);
  uint8_t high = (uint8_t)((((fb >> 11) & 7) << 3) | ((fb >> 8) & 7));
  uint8_t low = (uint8_t)(fb & 0xff);
  if (op == 4) {
    ym_always(s, 0, 0xa6, high); /* op4 uses CH3's own F-number pair */
    ym_always(s, 0, 0xa2, low);
  } else {
    static const uint8_t map[3] = {1, 2, 0}; /* OP1->A9/AD, OP2->AA/AE, OP3->A8/AC */
    uint8_t idx = map[op - 1];
    ym_always(s, 0, (uint8_t)(0xac + idx), high);
    ym_always(s, 0, (uint8_t)(0xa8 + idx), low);
  }
}

static void key_on(MMLSeq *s, int ch) {
  MMLFmCh *c = &s->fm[ch];
  uint8_t port = ch >= 3 ? 1 : 0;
  uint8_t chkey = (uint8_t)((port << 2) | (ch % 3));
  if (c->vol == 0 || s->master == 0) return; /* hard mute skips key-on */
  c->keyed = 1;
  ym_key(s, (uint8_t)(0xf0 | chkey));
}
static void key_off(MMLSeq *s, int ch) {
  MMLFmCh *c = &s->fm[ch];
  uint8_t port = ch >= 3 ? 1 : 0;
  uint8_t chkey = (uint8_t)((port << 2) | (ch % 3));
  if (!c->keyed) return;
  c->keyed = 0;
  ym_key(s, chkey);
}
static void channel_off(MMLSeq *s, int ch) {
  int op = fm3_op_for(s, ch);
  if (op) {
    fm3_key_op(s, op, 0);
    return;
  }
  if (ch < 6) {
    key_off(s, ch);
  } else if (ch < 10) {
    s->psg[ch - 6].keyed = 0;
    if (s->psg[ch - 6].sounding) write_psg_att(s, ch - 6, 15);
  }
}

static void recompose_carriers(MMLSeq *s, int ch) {
  MMLFmCh *c = &s->fm[ch];
  uint8_t port = ch >= 3 ? 1 : 0, off = (uint8_t)(ch % 3);
  uint8_t mask = MML_CARRIER_MASK[c->algorithm & 7];
  for (int op = 0; op < 4; op++) {
    if (!(mask & (1 << op))) continue;
    uint8_t tl = carrier_tl(s, c->ops[op].voiced_tl, c->vel, c->vol);
    c->ops[op].tl = tl;
    ym(s, port, (uint8_t)(0x40 + MML_OP_ADDR_OFFSET[op] + off), tl);
  }
}

/* ── PARAM_SET (opcodes.md §7) ─────────────────────────────────────────────
 * `force` marks a macro-driven write. A macro is the channel's envelope
 * authority, so its PSG attenuation has to land even after key-off — the
 * release region (`:off`) runs entirely while keyed is false and IS the decay
 * tail. Everything else (sweeps, the host API) keeps the keyed guard, so it can
 * never un-mute a silenced channel.
 */
static void param_set_ex(MMLSeq *s, int ch, int target, int value, int force) {
  if (target == T_MASTER) {
    s->master = (uint8_t)clampi(value, 0, 31);
    for (int c = 0; c < 6; c++) recompose_carriers(s, c);
    for (int p = 0; p < 4; p++) {
      if (!s->psg[p].sounding) continue;
      write_psg_att(s, p, psg_att(s, s->psg[p].vel, s->psg[p].vol));
    }
    /* PCM voices ride master too — recompose each voice's shift/mute. */
    for (int vi = 0; vi < MML_PCM_VOICES; vi++) pcm_compose_shift(s, vi);
    return;
  }
  if (target == T_LFO_RATE) {
    int rate = clampi(value, 0, 8);
    s->lfo_rate = (uint8_t)rate;
    ym(s, 0, 0x22, (uint8_t)(rate == 0 ? 0x00 : 0x08 | ((rate - 1) & 7)));
    return;
  }
  if (target == T_NOISE_MODE) {
    s->noise_mode = (uint8_t)(value & 7);
    if (s->psg[3].sounding) write_noise_cfg(s);
    return;
  }
  if (target == T_GATE) {
    uint8_t g = (uint8_t)clampi(value, 0, 8);
    if (ch < 6) s->fm[ch].gate = g;
    else if (ch < 10) s->psg[ch - 6].gate = g;
    return;
  }
  if (ch >= 6 && ch < 10) {
    int pc = ch - 6;
    MMLPsgCh *st = &s->psg[pc];
    if (target == T_VOL || target == T_VEL) {
      if (target == T_VOL) st->vol = (uint8_t)clampi(value, 0, 31);
      else st->vel = (uint8_t)clampi(value, 0, 15);
      /* Re-apply on a keyed note even when currently silent, so a level macro
       * can bring it back up (driver.md §13.3). */
      if (st->keyed || force) write_psg_att(s, pc, psg_att(s, st->vel, st->vol));
    } else if (target == T_NOTE_PITCH) {
      st->pitch_cents = (int16_t)value;
      if (pc < 3) write_psg_pitch(s, pc, st->current_note, value);
    }
    return;
  }
  /* PCM soft-mix levels: per-voice state, composed into the mixer's shift. */
  if (ch >= CH_PCM1 && ch <= CH_PCM3) {
    MMLPcmVoice *v = &s->pcm[ch - CH_PCM1];
    if (target == T_VEL) v->vel = (uint8_t)clampi(value, 0, 15);
    else if (target == T_VOL) v->vol = (uint8_t)clampi(value, 0, 31);
    else return;
    pcm_compose_shift(s, ch - CH_PCM1);
    return;
  }
  if (ch >= 6) return; /* fm3-op ids have no register param path */

  MMLFmCh *c = &s->fm[ch];
  uint8_t port = ch >= 3 ? 1 : 0, off = (uint8_t)(ch % 3);
  if (target == T_NOTE_PITCH) {
    c->pitch_cents = (int16_t)value;
    write_fm_pitch(s, ch, c->current_note, value);
    return;
  }
  if (target == T_VEL || target == T_VOL) {
    if (target == T_VEL) c->vel = (uint8_t)clampi(value, 0, 15);
    else c->vol = (uint8_t)clampi(value, 0, 31);
    recompose_carriers(s, ch);
    return;
  }
  if (target == T_FM_FB) {
    c->feedback = (uint8_t)(value & 7);
    ym(s, port, (uint8_t)(0xb0 + off), enc_b0(c));
    return;
  }
  if (target == T_FM_ALG) {
    c->algorithm = (uint8_t)(value & 7);
    ym(s, port, (uint8_t)(0xb0 + off), enc_b0(c));
    return;
  }
  if (target == T_FM_AMS || target == T_FM_FMS || target == T_PAN) {
    if (target == T_FM_AMS) c->ams = (uint8_t)(value & 3);
    else if (target == T_FM_FMS) c->fms = (uint8_t)(value & 7);
    else c->pan = (int8_t)clampi(value, -1, 1);
    ym(s, port, (uint8_t)(0xb4 + off), enc_b4(c));
    return;
  }

#define OPRANGE(base) (target >= (base) && target <= (base) + 3)
  int idx = -1;
  if (OPRANGE(T_FM_TL1)) idx = target - T_FM_TL1;
  else if (OPRANGE(T_FM_AR1)) idx = target - T_FM_AR1;
  else if (OPRANGE(T_FM_DR1)) idx = target - T_FM_DR1;
  else if (OPRANGE(T_FM_SR1)) idx = target - T_FM_SR1;
  else if (OPRANGE(T_FM_RR1)) idx = target - T_FM_RR1;
  else if (OPRANGE(T_FM_SL1)) idx = target - T_FM_SL1;
  else if (OPRANGE(T_FM_KS1)) idx = target - T_FM_KS1;
  else if (OPRANGE(T_FM_ML1)) idx = target - T_FM_ML1;
  else if (OPRANGE(T_FM_DT1)) idx = target - T_FM_DT1;
  else if (OPRANGE(T_FM_SSG1)) idx = target - T_FM_SSG1;
  else if (OPRANGE(T_FM_AMEN1)) idx = target - T_FM_AMEN1;
  if (idx < 0) return;
  MMLOp *o = &c->ops[idx];
  uint8_t oo = (uint8_t)(MML_OP_ADDR_OFFSET[idx] + off);
  if (OPRANGE(T_FM_TL1)) {
    o->voiced_tl = (uint8_t)clampi(value, 0, 127);
    o->tl = o->voiced_tl;
    ym(s, port, (uint8_t)(0x40 + oo), o->tl);
  } else if (OPRANGE(T_FM_AR1) || OPRANGE(T_FM_KS1)) {
    if (OPRANGE(T_FM_AR1)) o->ar = (uint8_t)(value & 0x1f);
    else o->rs = (uint8_t)(value & 3);
    ym(s, port, (uint8_t)(0x50 + oo), (uint8_t)((o->rs << 6) | o->ar));
  } else if (OPRANGE(T_FM_DR1) || OPRANGE(T_FM_AMEN1)) {
    if (OPRANGE(T_FM_DR1)) o->dr = (uint8_t)(value & 0x1f);
    else o->amen = (uint8_t)(value & 1);
    ym(s, port, (uint8_t)(0x60 + oo), enc_60(o));
  } else if (OPRANGE(T_FM_SR1)) {
    o->d2r = (uint8_t)(value & 0x1f);
    ym(s, port, (uint8_t)(0x70 + oo), (uint8_t)(o->d2r & 0x1f));
  } else if (OPRANGE(T_FM_RR1) || OPRANGE(T_FM_SL1)) {
    if (OPRANGE(T_FM_RR1)) o->rr = (uint8_t)(value & 0x0f);
    else o->sl = (uint8_t)(value & 0x0f);
    ym(s, port, (uint8_t)(0x80 + oo), enc_80(o));
  } else if (OPRANGE(T_FM_ML1) || OPRANGE(T_FM_DT1)) {
    if (OPRANGE(T_FM_ML1)) o->mul = (uint8_t)(value & 0x0f);
    else o->dt = (int8_t)value; /* enc_30 maps the sign into the register */
    ym(s, port, (uint8_t)(0x30 + oo), enc_30(o));
  } else if (OPRANGE(T_FM_SSG1)) {
    o->ssg = (uint8_t)(value & 0x0f);
    ym(s, port, (uint8_t)(0x90 + oo), o->ssg);
  }
#undef OPRANGE
}

static void param_set(MMLSeq *s, int ch, int target, int value) {
  param_set_ex(s, ch, target, value, 0);
}

/* ── Reads (driver.md §6.4, §4.1) ─────────────────────────────────────────── */
static int read_slot(const MMLSeq *s, uint8_t slot) {
  /* Slot 0xFF is the built-in $time — frames since start, low 16 bits. */
  if (slot == 0xff) return (int)(s->frame & 0xffff);
  return s->val[slot & 0x0f];
}

/* The logical current value of a target, for the read-modify-write PARAM_ADD
 * takes. Op-param fields mirror the Z80's read_op_param: the family selects
 * the field, the low two bits the operator — reading state the sequencer
 * already keeps, so a relative write has a real base instead of a silent 0. */
static int read_param(const MMLSeq *s, int ch, int target) {
  if (target == T_MASTER) return s->master;
  if (target == T_VOL)
    return ch < 6 ? s->fm[ch].vol : ch < 10 ? s->psg[ch - 6].vol : 31;
  if (target == T_VEL)
    return ch < 6 ? s->fm[ch].vel : ch < 10 ? s->psg[ch - 6].vel : 15;
  if (target == T_GATE)
    return ch < 6 ? s->fm[ch].gate : ch < 10 ? s->psg[ch - 6].gate : 8;
  if (ch < 6) {
    const MMLFmCh *c = &s->fm[ch];
    if (target == T_NOTE_PITCH) return c->pitch_cents;
    if (target == T_FM_FB) return c->feedback;
    if (target == T_FM_ALG) return c->algorithm;
    if (target >= T_FM_TL1 && target <= T_FM_TL1 + 3)
      return c->ops[target - T_FM_TL1].voiced_tl;
    if (target >= T_FM_AR1 && target <= T_FM_AMEN4) {
      int fam = (target - T_FM_AR1) >> 2, op = (target - T_FM_AR1) & 3;
      const MMLOp *o = &c->ops[op];
      switch (fam) {
        case 0: return o->ar;
        case 1: return o->dr;
        case 2: return o->d2r;
        case 3: return o->rr;
        case 4: return o->sl;
        case 5: return o->rs;
        case 6: return o->mul;
        case 7: return o->dt;
        case 8: return o->ssg;
        default: return o->amen;
      }
    }
  } else if (ch < 10 && target == T_NOTE_PITCH) {
    return s->psg[ch - 6].pitch_cents;
  }
  return 0;
}

/* ── CSM (driver.md §9) ───────────────────────────────────────────────────── */
static void set_reg27(MMLSeq *s, uint8_t value) {
  s->reg27 = value;
  ym(s, 0, 0x27, s->reg27);
}
static void write_timer_a(MMLSeq *s, int period) {
  ym(s, 0, 0x24, (uint8_t)((period >> 2) & 0xff));
  ym(s, 0, 0x25, (uint8_t)(period & 0x03));
}

/* ── Sweep slots ──────────────────────────────────────────────────────────── */
static void start_sweep(MMLSeq *s, int ch, uint8_t target, uint8_t curve, int loop,
                        int from, int to, int len) {
  if (ch >= 10) return; /* fm3-op / pcm ids have no sweep engine */
  MMLSweep *sl = s->sweeps[ch];
  int idx = -1;
  for (int i = 0; i < 2; i++)
    if (sl[i].active && sl[i].target == target) { idx = i; break; }
  if (idx < 0)
    for (int i = 0; i < 2; i++)
      if (!sl[i].active) { idx = i; break; }
  if (idx < 0) idx = 0; /* overflow: evict slot 0, deterministically */
  sl[idx].active = 1;
  sl[idx].target = target;
  sl[idx].curve_id = curve;
  sl[idx].loop = (uint8_t)(loop ? 1 : 0);
  sl[idx].from = from;
  sl[idx].to = to;
  sl[idx].len = (uint16_t)(len < 1 ? 1 : len);
  sl[idx].frame = 0;
  sl[idx].phase16 = 0;
  sl[idx].step16 = sweep_step(len, loop);
}
static void stop_sweep(MMLSeq *s, int ch, uint8_t target) {
  if (ch >= 10) return;
  for (int i = 0; i < 2; i++)
    if (s->sweeps[ch][i].active && s->sweeps[ch][i].target == target)
      s->sweeps[ch][i].active = 0;
}
/* A new note cancels LOOP sweeps on its channel (opcodes.md §6: loop sweeps
 * run "until PARAM_SWEEP_STOP / next note"). One-shots — fades, glides —
 * survive it. */
static void cancel_loop_sweeps(MMLSeq *s, int ch) {
  if (ch >= 10) return;
  for (int i = 0; i < 2; i++)
    if (s->sweeps[ch][i].active && s->sweeps[ch][i].loop) s->sweeps[ch][i].active = 0;
}

/* ── Macro engine (driver.md §13) ──────────────────────────────────────────
 * A macro is a per-frame value stream bound to a target. MACRO_SET binds it
 * (sticky, one bind per target), NOTE_ON re-instantiates every bind into a
 * fresh running slot, and step 3 advances each slot one frame.
 *
 * Descriptors are decoded from MACRO_TABLE on demand rather than copied at
 * load: on the target the table is ROM, and this keeps the RAM cost of a song
 * at its running slots alone.
 */
static int macro_desc(const MMLSeq *s, int id, MMLMacro *m) {
  if (!s->macro_table || id < 0 || id >= (int)s->macro_count) return 0;
  const uint8_t *e = s->macro_table + 2 + (uint32_t)id * 8;
  uint32_t blob_base = 2 + (uint32_t)s->macro_count * 8;
  m->target = e[0];
  m->flags = e[1];
  m->step = e[2];
  m->loop_start = e[3];
  m->release = e[4];
  m->count = e[5];
  m->values = s->macro_table + blob_base + rd16(e, 6);
  /* Scaled macro (flags bit2): one value-slot id follows the values. */
  m->has_scale = (uint8_t)((m->flags & 4) != 0);
  m->scale_slot = m->has_scale ? m->values[(uint32_t)m->count * ((m->flags & 1) ? 2 : 1)] : 0;
  return 1;
}

/* One sample. The hold sentinel (0x80 / 0x8000) means "no write this step" —
 * which is how a macro leaves a parameter alone without knowing its value. */
static int macro_value(const MMLMacro *m, int idx, int *hold) {
  *hold = 1;
  if (idx < 0 || idx >= (int)m->count) return 0;
  if (m->flags & 1) {
    uint16_t raw = rd16(m->values, (uint32_t)idx * 2);
    if (raw == 0x8000) return 0;
    *hold = 0;
    return (int16_t)raw;
  }
  uint8_t raw = m->values[idx];
  if (raw == 0x80) return 0;
  *hold = 0;
  return (int8_t)raw;
}

/* Scaled-macro sample (§4.4): `(sample x depth) >> 8`, depth = the slot's low
 * byte. Magnitude-then-resign, so the truncation is toward zero and matches
 * sweep_value — all three players agree bit for bit. */
static int scale_macro_sample(int sample, int slot_value) {
  int depth = slot_value & 0xff;
  int mag = ((sample < 0 ? -sample : sample) * depth) >> 8;
  return sample < 0 ? -mag : mag;
}

static int channel_keyed(const MMLSeq *s, int ch) {
  if (ch < 6) return s->fm[ch].keyed;
  if (ch < 10) return s->psg[ch - 6].keyed;
  return 0;
}

static void macro_bind(MMLSeq *s, int ch, uint8_t target, uint8_t macro_id) {
  if (ch >= 10) return;
  for (int i = 0; i < s->bind_count[ch]; i++) {
    if (s->binds[ch][i].target == target) {
      s->binds[ch][i].macro_id = macro_id; /* replace in place: order is §13.3 */
      return;
    }
  }
  if (s->bind_count[ch] >= MML_MACRO_BINDS) return;
  s->binds[ch][s->bind_count[ch]].target = target;
  s->binds[ch][s->bind_count[ch]].macro_id = macro_id;
  s->bind_count[ch]++;
}
static void macro_unbind(MMLSeq *s, int ch, uint8_t target) {
  if (ch >= 10) return;
  for (int i = 0; i < s->bind_count[ch]; i++) {
    if (s->binds[ch][i].target != target) continue;
    for (int k = i + 1; k < s->bind_count[ch]; k++) s->binds[ch][k - 1] = s->binds[ch][k];
    s->bind_count[ch]--;
    return;
  }
}

/* NOTE_ON re-instantiates every bind into a fresh slot, in bind order (§13.1). */
static void macro_trigger(MMLSeq *s, int ch) {
  if (ch >= 10) return;
  for (int i = 0; i < s->bind_count[ch]; i++) {
    MMLMacroSlot *sl = &s->macro_slots[ch][i];
    sl->macro_id = s->binds[ch][i].macro_id;
    sl->state = MML_MACRO_RUN;
    sl->dead = 0;
    sl->cursor = 0;
    sl->step_clock = 0;
  }
  s->macro_slot_count[ch] = s->bind_count[ch];
}

/* NOTE_SEMI apply: write the pitch register at (current note + semitones)
 * without touching the channel's sticky :pitch offset — a chiptune arpeggio is
 * a key-on offset, not a detune that should outlive the macro. `add` rides the
 * live offset instead of overriding it to 0. */
static void write_note_semi(MMLSeq *s, int ch, int semi, int add) {
  if (ch < 6) {
    write_fm_pitch(s, ch, s->fm[ch].current_note + semi, add ? s->fm[ch].pitch_cents : 0);
  } else if (ch < 10) {
    int p = ch - 6;
    if (p < 3) write_psg_pitch(s, p, s->psg[p].current_note + semi, add ? s->psg[p].pitch_cents : 0);
  }
}

/* KEYON retrigger (driver.md §14): re-attack the note. Restart every other
 * running macro on the channel (they are the soft envelope) and, on FM, re-key
 * the hardware EG. PSG has no hardware EG, so there the macro restart is the
 * whole effect. */
static void keyon_retrigger(MMLSeq *s, int ch) {
  for (int i = 0; i < s->macro_slot_count[ch]; i++) {
    MMLMacroSlot *sl = &s->macro_slots[ch][i];
    if (sl->dead) continue;
    MMLMacro d;
    if (!macro_desc(s, sl->macro_id, &d) || d.target == T_KEYON) continue;
    sl->cursor = 0;
    sl->step_clock = 0;
    sl->state = MML_MACRO_RUN;
  }
  int op = fm3_op_for(s, ch);
  if (op) {
    fm3_key_op(s, op, 0);
    fm3_key_op(s, op, 1);
  } else if (ch < 6) {
    key_off(s, ch);
    key_on(s, ch);
  }
}

/* One running slot, one frame. Returns 1 when the slot is finished.
 * Regions (mmb.md §15): attack [0..loop_start), sustain [loop_start..release)
 * cycled while keyed, release [release..count) once after key-off. */
static int step_macro(MMLSeq *s, int ch, MMLMacroSlot *sl, int keyed) {
  MMLMacro d;
  if (!macro_desc(s, sl->macro_id, &d)) return 1;
  /* Key-off leaves attack/sustain for the release region — or ends the slot. */
  if ((sl->state == MML_MACRO_RUN || sl->state == MML_MACRO_HOLD) && !keyed) {
    if (d.release != 0xff && d.release < d.count) {
      sl->state = MML_MACRO_RELEASE;
      sl->cursor = d.release;
      sl->step_clock = 0; /* release[0] fires on the key-off frame */
    } else {
      return 1;
    }
  }
  if (sl->step_clock > 0) {
    sl->step_clock--;
    return 0;
  }
  if (sl->state == MML_MACRO_HOLD) return 0; /* one-shot: hold, await key-off */

  int hold;
  int v = macro_value(&d, (int)sl->cursor, &hold);
  if (!hold) {
    if (d.has_scale) v = scale_macro_sample(v, read_slot(s, d.scale_slot));
    int add = (d.flags & 2) != 0;
    if (d.target == T_NOTE_SEMI) {
      write_note_semi(s, ch, v, add);
    } else if (d.target == T_KEYON) {
      if (v != 0) keyon_retrigger(s, ch);
    } else if (d.target == T_NOTE_PITCH) {
      /* Pitch macro: write the register every frame but never store back to
       * pitch_cents, which holds the :pitch directive's base. An override macro
       * that clobbered it would leave a residual detune on every later note. */
      if (ch < 6) {
        int base = add ? s->fm[ch].pitch_cents : 0;
        write_fm_pitch(s, ch, s->fm[ch].current_note, base + v);
      } else if (ch - 6 < 3) {
        int p = ch - 6;
        int base = add ? s->psg[p].pitch_cents : 0;
        write_psg_pitch(s, p, s->psg[p].current_note, base + v);
      }
    } else {
      param_set_ex(s, ch, d.target, v, 1); /* the macro owns the envelope */
    }
  }
  sl->step_clock = (int16_t)(d.step - 1);
  if (sl->state == MML_MACRO_RUN) {
    sl->cursor++;
    int sustain_end = d.release == 0xff ? d.count : d.release;
    if (sl->cursor >= (uint16_t)sustain_end) {
      if (d.loop_start != 0xff) sl->cursor = d.loop_start; /* sustain loop */
      else sl->state = MML_MACRO_HOLD;                     /* hold last value */
    }
  } else {
    sl->cursor++;
    if (sl->cursor >= (uint16_t)d.count) return 1; /* release finished */
  }
  return 0;
}

static void process_macros(MMLSeq *s) {
  for (int ch = 0; ch < 10; ch++) {
    int n = s->macro_slot_count[ch];
    if (!n) continue;
    int keyed = channel_keyed(s, ch);
    int dead = 0;
    /* A KEYON step can reach back into this array (keyon_retrigger), so slots
     * are marked dead in place and compacted only after the whole pass. */
    for (int i = 0; i < n; i++) {
      if (step_macro(s, ch, &s->macro_slots[ch][i], keyed)) {
        s->macro_slots[ch][i].dead = 1;
        dead = 1;
      }
    }
    if (!dead) continue;
    int w = 0;
    for (int i = 0; i < n; i++) {
      if (s->macro_slots[ch][i].dead) continue;
      if (w != i) s->macro_slots[ch][w] = s->macro_slots[ch][i];
      w++;
    }
    s->macro_slot_count[ch] = (uint8_t)w;
  }
}

/* ── PCM voices (driver.md §14) ────────────────────────────────────────────
 * The 68k resolves the note into a PCM_START the engine can act on with no
 * arithmetic, then shadows the voice's position so it knows when the voice is
 * gone. It never touches a sample byte — that is the Z80's entire job.
 */
static const uint8_t *find_sample(const MMLSeq *s, int id) {
  for (uint16_t i = 0; i < s->sample_count; i++) {
    const uint8_t *e = s->sample_entries + (uint32_t)i * 20;
    if (e[0] == (uint8_t)id) return e;
  }
  return 0;
}

/* 16.16 position advance per mix tick. Computed at full precision then floored,
 * so pitch stays accurate — a table pre-divided by the mix rate rounds far too
 * coarsely (mmb.js pcmTickIncrement is the definition). */
static uint32_t pcm_tick_increment(int base_rate, int note) {
  int n = clampi(note, 36, 84);
  uint32_t per_frame = (uint32_t)base_rate * MML_PCM_MULT_FRAME[n - 36];
  return per_frame / MML_PCM_MIX_RATE;
}

static void pcm_note_on(MMLSeq *s, int channel_id, int sample_id, int note) {
  int vi = channel_id - CH_PCM1;
  if (vi < 0 || vi >= MML_PCM_VOICES) return;
  const uint8_t *e = find_sample(s, sample_id);
  if (!e) return;
  uint32_t len = rd32(e, 6);
  if (len == 0) return;
  MMLPcmVoice *v = &s->pcm[vi];
  v->active = 1;
  v->base = s->sample_blob_base + rd32(e, 2);
  v->len = len;
  v->has_loop = (uint8_t)(e[1] & 1);
  v->loop_start = rd32(e, 12);
  v->loop_end = v->has_loop ? rd32(e, 16) : len;
  v->loop_len = v->loop_end - v->loop_start;
  v->left = (int32_t)v->loop_end;        /* to the loop end, or the sample end */
  v->tail = (int32_t)(len - v->loop_end); /* what a release still has to play */
  v->inc = pcm_tick_increment(rd16(e, 10), note);
  v->pos = 0;
  v->releasing = 0;
  /* $2B (DAC enable) is the ENGINE's: it is a consequence of voice activity,
   * the one piece of state the Z80 already owns (driver.md §14). */
  emit_pcm_start(s, vi, v);
  v->sent_shift = pcm_shift_byte(v);
}

static void pcm_note_off(MMLSeq *s, int channel_id) {
  /* A shot plays to its end regardless (opcodes.md §6); a loop leaves its loop
   * region and plays out the tail to the sample end. */
  int vi = channel_id - CH_PCM1;
  if (vi < 0 || vi >= MML_PCM_VOICES) return;
  MMLPcmVoice *v = &s->pcm[vi];
  if (!v->active || !v->has_loop) return;
  v->releasing = 1;
  v->left += v->tail; /* the boundary moves from the loop end to the sample end */
  uint8_t c[2] = {PCM_STOP, (uint8_t)vi};
  pcm_emit(s, c, 2);
}

/* Advance every active voice over the frame's mix ticks. No samples are read —
 * this is position bookkeeping only, mirroring the engine's loop so both sides
 * retire a voice on the same tick. (A closed form exists for the non-looping
 * case; it is not worth the divergence risk until a cycle count asks for it.) */
static void pcm_frame(MMLSeq *s) {
  int any = 0;
  for (int i = 0; i < MML_PCM_VOICES; i++) any |= s->pcm[i].active;
  if (!any) {
    if (s->pcm_dac_on) {
      s->pcm_dac_on = 0;
      ym(s, 0, 0x2b, 0x00); /* release fm6 back to FM — shadow only, §14 */
    }
    return;
  }
  if (!s->pcm_dac_on) {
    s->pcm_dac_on = 1;
    ym(s, 0, 0x2b, 0x80);
  }
  for (int i = 0; i < MML_PCM_VOICES; i++) {
    MMLPcmVoice *v = &s->pcm[i];
    for (int t = 0; t < MML_PCM_MIX_RATE && v->active; t++) {
      uint32_t before = v->pos >> 16;
      v->pos += v->inc;
      v->left -= (int32_t)((v->pos >> 16) - before);
      if (v->left > 0) continue;
      if (v->has_loop && !v->releasing) {
        v->pos -= v->loop_len << 16;
        v->left = (int32_t)v->loop_len;
      } else {
        v->active = 0;
      }
    }
  }
}

/* ── VOICE_SET (driver.md §10) ──────────────────────────────────────────────
 * Apply a 29-byte VOICE_TABLE entry: the register-order block that a
 * full-voice PARAM_SET burst was coalesced into. Change-only is taken against
 * the STRUCTURED shadow, not the register shadow — the burst only wrote a
 * register some PARAM_SET touched, so e.g. $90/SSG (which the neutral patch
 * never writes) has to stay unwritten when the voice omits it. The old byte is
 * derived from the current op fields before they are overwritten.
 */
static void voice_set(MMLSeq *s, int ch, uint8_t voice_id) {
  if (ch >= 6 || voice_id >= s->voice_count) return;
  const uint8_t *e = s->voices + (uint32_t)voice_id * 29;
  MMLFmCh *c = &s->fm[ch];
  uint8_t port = ch >= 3 ? 1 : 0, off = (uint8_t)(ch % 3);
  for (int op = 0; op < 4; op++) {
    MMLOp *o = &c->ops[op];
    uint8_t oo = (uint8_t)(MML_OP_ADDR_OFFSET[op] + off);
    uint8_t b;
    b = e[0 + op];
    if (b != enc_30(o)) ym(s, port, (uint8_t)(0x30 + oo), b);
    o->dt = (int8_t)((b >> 4) & 7);
    o->mul = (uint8_t)(b & 0x0f);
    b = e[4 + op];
    if (b != o->tl) ym(s, port, (uint8_t)(0x40 + oo), b);
    o->voiced_tl = b;
    o->tl = b;
    b = e[8 + op];
    if (b != (uint8_t)((o->rs << 6) | o->ar)) ym(s, port, (uint8_t)(0x50 + oo), b);
    o->rs = (uint8_t)((b >> 6) & 3);
    o->ar = (uint8_t)(b & 0x1f);
    b = e[12 + op];
    if (b != enc_60(o)) ym(s, port, (uint8_t)(0x60 + oo), b);
    o->amen = (uint8_t)((b >> 7) & 1);
    o->dr = (uint8_t)(b & 0x1f);
    b = e[16 + op];
    if (b != o->d2r) ym(s, port, (uint8_t)(0x70 + oo), b);
    o->d2r = (uint8_t)(b & 0x1f);
    b = e[20 + op];
    if (b != enc_80(o)) ym(s, port, (uint8_t)(0x80 + oo), b);
    o->sl = (uint8_t)((b >> 4) & 0x0f);
    o->rr = (uint8_t)(b & 0x0f);
    b = e[24 + op];
    if (b != o->ssg) ym(s, port, (uint8_t)(0x90 + oo), b);
    o->ssg = (uint8_t)(b & 0x0f);
  }
  uint8_t b0 = e[28];
  if (b0 != (uint8_t)((c->feedback << 3) | c->algorithm))
    ym(s, port, (uint8_t)(0xb0 + off), b0);
  c->feedback = (uint8_t)((b0 >> 3) & 7);
  c->algorithm = (uint8_t)(b0 & 7);
}

/* ── Note on (opcodes.md §3.1) ─────────────────────────────────────────────── */
static void note_on(MMLSeq *s, MMLTrack *t, int note, int32_t dur, int32_t ex_gate,
                    int has_ex_gate, int legato) {
  int ch = t->channel_id;
  int fm3op = fm3_op_for(s, ch);
  if (!fm3op && ch > CH_PCM3) return; /* no such channel: timeline only */
  cancel_loop_sweeps(s, ch);
  if (fm3op) {
    /* FM3 independent-OP: the F-number came from the preceding FM3_OP_PITCH,
     * so this only keys the operator. Level and patch stay the shared CH3's. */
    fm3_key_op(s, fm3op, 1);
  } else if (ch < 6) {
    MMLFmCh *c = &s->fm[ch];
    c->current_note = (uint8_t)note;
    /* Carrier TL is recomposed on every note, so a level change between notes
     * always lands (matching the IR player). */
    recompose_carriers(s, ch);
    write_fm_pitch(s, ch, note, c->pitch_cents);
    if (!legato) key_on(s, ch);
  } else if (ch < 10) {
    int pc = ch - 6;
    MMLPsgCh *st = &s->psg[pc];
    st->current_note = (uint8_t)note;
    if (!legato) st->keyed = 1;
    if (pc == 3) write_noise_cfg(s);
    else write_psg_pitch(s, pc, note, st->pitch_cents);
    /* Legato keeps the tone sounding — the attenuation IS the PSG's key — but a
     * silent channel still has to start its attenuation. */
    if (!legato || !st->sounding) write_psg_att(s, pc, psg_att(s, st->vel, st->vol));
  }

  /* Re-trigger the channel's bound macros (driver.md §13.1). Their first step
   * fires this frame in step 3, overriding the note-on's base level. */
  if (!fm3op && ch < 10) macro_trigger(s, ch);

  int gate = fm3op ? 8 : ch < 6 ? s->fm[ch].gate : ch < 10 ? s->psg[ch - 6].gate : 8;
  if (dur == 0 || (has_ex_gate && ex_gate == 0)) {
    t->held = 1;
    t->gate_left = -1;
    return;
  }
  t->wait = dur;
  if (has_ex_gate) {
    /* Absolute ticks from note-on. Counts across TIE segments (a tie extends
     * `wait` and never touches this), so a gate outlasting its own note keys
     * off mid-tie rather than being clamped to the first segment. */
    t->gate_left = ex_gate;
    t->pending_off = 0;
  } else if (gate < 8) {
    int32_t g = (dur * gate) >> 3;
    t->gate_left = g < 1 ? 1 : g;
    t->pending_off = 0;
  } else {
    t->gate_left = -1;
    t->pending_off = 1; /* full gate: key-off waits on the slur test */
  }
}

/* ── Dispatch ─────────────────────────────────────────────────────────────── */
typedef struct {
  int32_t ticks;
  uint32_t next;
} MMLDur;
static MMLDur read_dur(const uint8_t *b, uint32_t o) {
  MMLDur d;
  if (b[o] == DUR_HOLD) {
    d.ticks = 0;
    d.next = o + 1;
  } else if (b[o] == DUR_EXT) {
    d.ticks = b[o + 1] | (b[o + 2] << 8);
    d.next = o + 3;
  } else {
    d.ticks = b[o];
    d.next = o + 1;
  }
  return d;
}

static void dispatch(MMLSeq *s, MMLTrack *t) {
  const uint8_t *st = s->stream;
  int guard = 0;
  while (t->running && !t->held && guard++ < 4096) {
    uint8_t op = st[t->pc];
    /* An armed track runs the score's leading setup and stops at the first
     * opcode that sounds or consumes time, so the frame it was started in
     * makes no sound however long its voice applies take (driver.md §4.2). */
    if (t->armed && op >= OP_NOTE_ON && op <= OP_NOTE_ON_EX) return;
    switch (op) {
      case OP_END_OF_TRACK:
        t->pending_off = 0;
        channel_off(s, t->channel_id);
        /* Stopping the fm3-csm track must clear CSM — the flag exists in the
         * track table precisely so stopping never leaves the chip in it (§9). */
        if (t->flags & TRACK_FLAG_IS_CSM) set_reg27(s, (uint8_t)(s->reg27 & ~0x80));
        t->running = 0;
        return;
      case OP_NOTE_ON: {
        int note = st[t->pc + 1];
        MMLDur d = read_dur(st, t->pc + 2);
        t->pending_off = 0; /* slur: an incoming note cancels the key-off */
        note_on(s, t, note, d.ticks, 0, 0, 0);
        t->pc = (uint16_t)d.next;
        if (d.ticks == 0) return;
        t->wait = d.ticks;
        return;
      }
      case OP_NOTE_ON_EX: {
        uint32_t pc = t->pc + 1;
        uint8_t flags = st[pc++];
        int note = st[pc++];
        int has_vel = (flags & 1) != 0;
        int ex_vel = has_vel ? st[pc++] : 0;
        MMLDur d = read_dur(st, pc);
        pc = d.next;
        int has_gate = (flags & 2) != 0;
        int32_t ex_gate = 0;
        if (has_gate) {
          MMLDur g = read_dur(st, pc);
          ex_gate = g.ticks;
          pc = g.next;
        }
        t->pending_off = 0;
        if (has_vel) {
          if (t->channel_id < 6) s->fm[t->channel_id].vel = (uint8_t)ex_vel;
          else if (t->channel_id < 10) s->psg[t->channel_id - 6].vel = (uint8_t)ex_vel;
        }
        note_on(s, t, note, d.ticks, ex_gate, has_gate, (flags & 8) != 0);
        t->pc = (uint16_t)pc;
        if (d.ticks == 0 || (has_gate && ex_gate == 0)) return;
        t->wait = d.ticks;
        return;
      }
      case OP_REST: {
        t->pending_off = 0;
        t->gate_left = -1; /* a rest cancels a gate still counting */
        channel_off(s, t->channel_id);
        MMLDur d = read_dur(st, t->pc + 1);
        t->pc = (uint16_t)d.next;
        t->wait = d.ticks == 0 ? 1 : d.ticks; /* defensive: no zero rests */
        return;
      }
      case OP_TIE: {
        t->pending_off = 0; /* an extension, not a retrigger */
        MMLDur d = read_dur(st, t->pc + 1);
        t->pc = (uint16_t)d.next;
        t->wait = d.ticks == 0 ? 1 : d.ticks;
        return;
      }
      case OP_LOOP_BEGIN: {
        uint8_t count = st[t->pc + 1];
        t->pc += 2;
        if (t->depth >= MML_LOOP_DEPTH) break;
        t->ctrl[t->depth].resume_pc = t->pc;
        t->ctrl[t->depth].remaining = (int16_t)(count - 1);
        t->depth++;
        break;
      }
      case OP_LOOP_END: {
        t->pc += 1;
        if (!t->depth) break;
        MMLCtrl *top = &t->ctrl[t->depth - 1];
        if (top->remaining > 0) {
          top->remaining--;
          t->pc = top->resume_pc;
        } else {
          t->depth--;
        }
        break;
      }
      case OP_LOOP_BREAK: {
        uint16_t skip = rd16(st, t->pc + 1);
        t->pc += 3;
        if (t->depth && t->ctrl[t->depth - 1].remaining == 0) {
          t->pc = (uint16_t)(t->pc + skip); /* final pass: leave the loop */
          t->depth--;
        }
        break;
      }
      case OP_MARKER:
        t->marker_id = (uint8_t)(st[t->pc + 1] & 0x3f);
        t->pc += 2;
        break;
      case OP_JUMP:
        t->pc = rd16(st, t->pc + 1); /* EVENT_STREAM-relative */
        break;
      case OP_CALL: {
        uint16_t dest = rd16(st, t->pc + 1);
        uint16_t resume = (uint16_t)(t->pc + 3);
        if (t->depth >= MML_LOOP_DEPTH) {
          t->pc = resume;
          break;
        }
        /* CALL and LOOP share the control stack; -1 tags a call (§5.2). */
        t->ctrl[t->depth].resume_pc = resume;
        t->ctrl[t->depth].remaining = -1;
        t->depth++;
        t->pc = dest;
        break;
      }
      case OP_RET: {
        if (t->depth && t->ctrl[t->depth - 1].remaining == -1) {
          t->depth--;
          t->pc = t->ctrl[t->depth].resume_pc;
        } else {
          t->pc += 1; /* malformed stream: step past */
        }
        break;
      }
      case OP_PARAM_SET: {
        uint8_t target = st[t->pc + 1];
        /* NOTE_PITCH is the one i16 target (opcodes.md §7). */
        if (target == T_NOTE_PITCH) {
          param_set(s, t->channel_id, target, (int16_t)rd16(st, t->pc + 2));
          t->pc += 4;
        } else {
          param_set(s, t->channel_id, target, (int8_t)st[t->pc + 2]);
          t->pc += 3;
        }
        break;
      }
      case OP_VOICE_SET:
        voice_set(s, t->channel_id, st[t->pc + 1]);
        t->pc += 2;
        break;
      case OP_PARAM_SWEEP: {
        uint8_t target = st[t->pc + 1], curve = st[t->pc + 2], flags = st[t->pc + 3];
        /* Dynamic endpoints: flags bit1/bit2 mark from/to as slot ids in the
         * field's low byte, read live at dispatch (the note-on tier). */
        int from = (flags & 2) ? read_slot(s, st[t->pc + 4])
                               : (int16_t)rd16(st, t->pc + 4);
        int to = (flags & 4) ? read_slot(s, st[t->pc + 6])
                             : (int16_t)rd16(st, t->pc + 6);
        int len = rd16(st, t->pc + 8);
        t->pc += 10;
        start_sweep(s, t->channel_id, target, curve, flags & 1, from, to, len);
        break;
      }
      case OP_PARAM_SWEEP_STOP:
        stop_sweep(s, t->channel_id, st[t->pc + 1]);
        t->pc += 2;
        break;
      case OP_PARAM_ADD: {
        uint8_t target = st[t->pc + 1];
        int wide = (target == T_NOTE_PITCH || target == T_TEMPO_SCALE);
        int delta = wide ? (int16_t)rd16(st, t->pc + 2) : (int8_t)st[t->pc + 2];
        t->pc += (uint16_t)(2 + (wide ? 2 : 1));
        param_set(s, t->channel_id, target,
                  read_param(s, t->channel_id, target) + delta);
        break;
      }
      /* ── Value machine: the stream ops (driver.md §6.4, opcodes.md §6) ──
       * The compiler lowers an expression to a left fold, so every one of these
       * is "current value OP operand" and the driver never needs a stack. */
      case OP_PARAM_MUL: {
        uint8_t target = st[t->pc + 1];
        int factor = rd16(st, t->pc + 2); /* unsigned 8.8 */
        t->pc += 4;
        param_set(s, t->channel_id, target,
                  (read_param(s, t->channel_id, target) * factor) >> 8);
        break;
      }
      case OP_PARAM_FROM_VAL: {
        uint8_t target = st[t->pc + 1];
        int v = read_slot(s, st[t->pc + 2]);
        t->pc += 3;
        param_set(s, t->channel_id, target, v);
        break;
      }
      case OP_PARAM_ADD_VAL: {
        uint8_t target = st[t->pc + 1];
        int v = read_slot(s, st[t->pc + 2]);
        t->pc += 3;
        param_set(s, t->channel_id, target,
                  read_param(s, t->channel_id, target) + v);
        break;
      }
      case OP_PARAM_MUL_VAL: {
        uint8_t target = st[t->pc + 1];
        int factor = read_slot(s, st[t->pc + 2]); /* 8.8 */
        t->pc += 3;
        param_set(s, t->channel_id, target,
                  (read_param(s, t->channel_id, target) * factor) >> 8);
        break;
      }
      case OP_TEMPO_SWEEP: {
        int from = rd16(st, t->pc + 1), to = rd16(st, t->pc + 3);
        int len = rd16(st, t->pc + 5);
        uint8_t curve = st[t->pc + 7];
        t->pc += 8;
        s->tempo_sweep.active = 1;
        s->tempo_sweep.curve_id = curve;
        s->tempo_sweep.from = from;
        s->tempo_sweep.to = to;
        s->tempo_sweep.len = (uint16_t)(len < 1 ? 1 : len);
        s->tempo_sweep.frame = 0;
        s->tempo_sweep.phase16 = 0;
        s->tempo_sweep.step16 = sweep_step(len, 0);
        break;
      }
      case OP_CSM_ON:
        t->pc += 1;
        set_reg27(s, (uint8_t)(s->reg27 | 0x80));
        break;
      case OP_CSM_OFF:
        t->pc += 1;
        set_reg27(s, (uint8_t)(s->reg27 & ~0x80));
        break;
      case OP_CSM_RATE: {
        uint8_t flags = st[t->pc + 1];
        if (!(flags & 1)) {
          /* The period reaches the driver precomputed; Hz never does. */
          int period = rd16(st, t->pc + 2);
          t->pc += 4;
          write_timer_a(s, period);
        } else {
          int from = rd16(st, t->pc + 2), to = rd16(st, t->pc + 4);
          int len = rd16(st, t->pc + 6);
          uint8_t curve = st[t->pc + 8];
          t->pc += 9;
          s->csm_sweep.active = 1;
          s->csm_sweep.curve_id = curve;
          s->csm_sweep.from = from;
          s->csm_sweep.to = to;
          s->csm_sweep.len = (uint16_t)(len < 1 ? 1 : len);
          s->csm_sweep.frame = 0;
          s->csm_sweep.phase16 = 0;
          s->csm_sweep.step16 = sweep_step(len, 0);
        }
        break;
      }
      case OP_FM3_MODE: {
        uint8_t mode = st[t->pc + 1]; /* 0 normal, 1 special (per-op), 2 CSM */
        t->pc += 2;
        uint8_t r = (uint8_t)(s->reg27 & ~0xc0);
        if (mode == 1) r |= 0x40;
        else if (mode == 2) r |= 0x80;
        set_reg27(s, r);
        break;
      }
      case OP_FM3_OP_PITCH: {
        int opn = st[t->pc + 1], note = st[t->pc + 2];
        t->pc += 3;
        write_fm3_op_pitch(s, opn, note);
        break;
      }
      case OP_PCM_NOTE_ON: {
        int sample_id = st[t->pc + 1], note = st[t->pc + 2];
        MMLDur d = read_dur(st, t->pc + 3);
        t->pc = (uint16_t)d.next;
        pcm_note_on(s, t->channel_id, sample_id, note);
        /* A held (dur 0) PCM note suspends the dispatcher like any hold; the
         * sample keeps feeding from step 3 either way. */
        if (d.ticks == 0) {
          t->held = 1;
          return;
        }
        t->wait = d.ticks;
        return;
      }
      case OP_PCM_NOTE_OFF:
        t->pc += 1;
        pcm_note_off(s, t->channel_id);
        break;
      case OP_MACRO_SET: {
        uint8_t macro_id = st[t->pc + 1];
        t->pc += 2;
        MMLMacro d;
        /* Sticky: this becomes the channel's macro for that target, replacing
         * whatever was bound there (driver.md §13.1). */
        if (macro_desc(s, macro_id, &d) && t->channel_id < 10)
          macro_bind(s, t->channel_id, d.target, macro_id);
        break;
      }
      case OP_MACRO_CLEAR: {
        uint8_t target = st[t->pc + 1];
        t->pc += 2;
        if (t->channel_id < 10) {
          if (target == 0xff) s->bind_count[t->channel_id] = 0;
          else macro_unbind(s, t->channel_id, target);
        }
        break;
      }
      case OP_TEMPO_SET:
        /* Tempo is score-global: a TEMPO_SET on any track replaces the
         * increment for every track of its MMB (driver.md §3.2). */
        s->increment = rd16(st, t->pc + 1);
        t->pc += 3;
        break;
      default:
        /* Fail-safe, like the Z80's unknown-opcode rule (mmb.md §13): stop the
         * track rather than mis-decode a length and walk into noise. M2/M3
         * opcodes land here until they are ported. */
        t->running = 0;
        if (!s->stopped) {
          s->stopped = 1;
          s->stopped_op = op;
          s->stopped_frame = s->frame;
        }
        return;
    }
  }
}

/* ── Frame step 3: the engines (driver.md §4) ──────────────────────────────
 * One sweep slot, one frame. Returns 1 when a one-shot completes and the
 * caller should free the slot; loop sweeps never complete on their own. */
static int process_sweep(MMLSeq *s, int ch, MMLSweep *sl) {
  if (!sl->loop && sl->frame >= sl->len - 1) {
    param_set(s, ch, sl->target, sl->to); /* land exactly on the endpoint */
    return 1;
  }
  int unit = curve_unit8(sl->curve_id, sl->phase16 >> 8);
  param_set(s, ch, sl->target, sweep_value(sl->from, sl->to, unit));
  sl->phase16 = (uint16_t)(sl->phase16 + sl->step16);
  if (!sl->loop) sl->frame++;
  return 0;
}
static int process_global_sweep(MMLGlobalSweep *g, int *out) {
  if (g->frame >= g->len - 1) {
    *out = g->to;
    return 1;
  }
  int unit = curve_unit8(g->curve_id, g->phase16 >> 8);
  *out = sweep_value(g->from, g->to, unit);
  g->phase16 = (uint16_t)(g->phase16 + g->step16);
  g->frame++;
  return 0;
}
static void stop_track(MMLSeq *s, MMLTrack *t) {
  channel_off(s, t->channel_id);
  if (t->flags & TRACK_FLAG_IS_CSM) set_reg27(s, (uint8_t)(s->reg27 & ~0x80));
  t->running = 0;
  t->fading = 0;
}
static void process_fades(MMLSeq *s) {
  for (uint8_t i = 0; i < s->track_count; i++) {
    MMLTrack *t = &s->trk[i];
    if (!t->fading) continue;
    t->fade_frame++;
    t->fade_err += t->fade_vol;
    while (t->fade_err >= (int32_t)t->fade_n) {
      t->fade_err -= (int32_t)t->fade_n;
      t->fade_cur--;
    }
    param_set(s, t->channel_id, T_VOL, t->fade_cur < 0 ? 0 : (int)t->fade_cur);
    if (t->fade_frame >= t->fade_n) stop_track(s, t);
  }
}

/* ── Frame ────────────────────────────────────────────────────────────────── */
static uint32_t encode_slot(MMLSeq *s, uint8_t *out) {
  /* Take up to the cap, in order, then bucket into the three runs. Bucketing
   * loses cross-port order within a frame, which is safe by construction:
   * everything whose order carries meaning is port-0-local (driver.md §4). */
  uint16_t queued = mml_pending(s);
  uint16_t take = queued < MML_SLOT_MAX_WRITES ? queued : MML_SLOT_MAX_WRITES;
  uint8_t psg[MML_SLOT_MAX_WRITES];
  uint8_t fm0[MML_SLOT_MAX_WRITES * 2], fm1[MML_SLOT_MAX_WRITES * 2];
  uint16_t np = 0, n0 = 0, n1 = 0;
  uint16_t cur = s->q_tail;
  /* The BYTE budget can bind before the write budget when PCM commands are
   * dense (three PCM_STARTs are 54 B), so keep the longest PREFIX that fits
   * rather than overflow the slot. What is dropped stays queued, in order. */
  {
    uint32_t size = 4 + s->pcm_len; /* three run lengths + n_pcm + the commands */
    uint16_t fit = 0, scan = cur;
    for (uint16_t i = 0; i < take; i++) {
      uint32_t cost = s->q[scan].port == 2 ? 1 : 2; /* PSG is a bare byte */
      if (size + cost > MML_SLOT_SIZE) break;
      size += cost;
      fit++;
      scan = (uint16_t)((scan + 1) % MML_WRITE_QUEUE);
    }
    take = fit;
  }
  for (uint16_t i = 0; i < take; i++) {
    uint8_t port = s->q[cur].port, addr = s->q[cur].addr, data = s->q[cur].data;
    if (port == 2) psg[np++] = data;
    else if (port == 1) { fm1[n1++] = addr; fm1[n1++] = data; }
    else { fm0[n0++] = addr; fm0[n0++] = data; }
    cur = (uint16_t)((cur + 1) % MML_WRITE_QUEUE);
  }
  s->q_tail = cur;

  uint32_t o = 0;
  out[o++] = (uint8_t)np;
  mml_copy(out + o, psg, np); o += np;
  out[o++] = (uint8_t)(n0 / 2);
  mml_copy(out + o, fm0, n0); o += n0;
  out[o++] = (uint8_t)(n1 / 2);
  mml_copy(out + o, fm1, n1); o += n1;
  out[o++] = s->pcm_count;
  mml_copy(out + o, s->pcm_buf, s->pcm_len); o += s->pcm_len;
  s->pcm_count = 0;
  s->pcm_len = 0;

  uint16_t left = mml_pending(s);
  if (left) {
    s->spill_frames++;
    if (left > s->spill_peak) s->spill_peak = left;
  }
  return o;
}

uint16_t mml_pending(const MMLSeq *s) {
  return (uint16_t)((s->q_head + MML_WRITE_QUEUE - s->q_tail) % MML_WRITE_QUEUE);
}

uint32_t mml_render_frame(MMLSeq *s, uint8_t *slot_out) {
  for (uint8_t i = 0; i < s->track_count; i++) {
    MMLTrack *t = &s->trk[i];
    if (!t->running || t->held) continue;
    if (t->armed) {
      dispatch(s, t); /* leading setup only — see the armed test in dispatch */
      t->armed = 0;   /* notes start next frame */
      continue;
    }
    t->acc = (uint16_t)(t->acc + s->increment);
    while (t->acc >= 0x100) {
      t->acc -= 0x100;
      /* One tick: gate countdown first, then the wait countdown / dispatch. */
      if (t->gate_left > 0) {
        t->gate_left--;
        if (t->gate_left == 0) {
          channel_off(s, t->channel_id);
          t->gate_left = -1;
        }
      }
      if (t->wait > 0) t->wait--;
      if (t->wait == 0) {
        dispatch(s, t);
        if (!t->running || t->held) break;
      }
    }
  }
  /* Step 3, in the normative order: sweeps ascending channel then slot, then
   * the macros (same write path, §13.3), the global tempo and CSM-rate sweeps,
   * the fades, and finally the PCM voices. */
  for (int ch = 0; ch < 10; ch++) {
    for (int i = 0; i < 2; i++) {
      MMLSweep *sl = &s->sweeps[ch][i];
      if (sl->active && process_sweep(s, ch, sl)) sl->active = 0;
    }
  }
  process_macros(s);
  if (s->tempo_sweep.active) {
    int v;
    if (process_global_sweep(&s->tempo_sweep, &v)) s->tempo_sweep.active = 0;
    s->increment = (uint16_t)v;
  }
  if (s->csm_sweep.active) {
    int v;
    if (process_global_sweep(&s->csm_sweep, &v)) s->csm_sweep.active = 0;
    write_timer_a(s, v);
  }
  process_fades(s);
  pcm_frame(s);
  s->frame++;
  return encode_slot(s, slot_out);
}

uint32_t mml_drain_frame(MMLSeq *s, uint8_t *slot_out) {
  return encode_slot(s, slot_out);
}

int mml_done(const MMLSeq *s) {
  /* Still busy while the DAC is feeding: a shot or a loop tail plays past the
   * note that started it, and past the end of its track. */
  for (int i = 0; i < MML_PCM_VOICES; i++)
    if (s->pcm[i].active) return 0;
  for (uint8_t i = 0; i < s->track_count; i++)
    if (s->trk[i].running && !s->trk[i].held) return 0;
  return 1;
}

/* ── Load / start ─────────────────────────────────────────────────────────── */
static void emit_init_writes(MMLSeq *s) {
  /* The neutral power-on patch. It has to cover every register anything writes
   * through the change-only layer: an unwritten shadow entry would let a first
   * write of 0 be suppressed, and on hardware a power-on SSG-EG bit would never
   * be cleared. */
  for (int ch = 0; ch < 6; ch++) {
    uint8_t port = ch >= 3 ? 1 : 0, off = (uint8_t)(ch % 3);
    MMLFmCh *c = &s->fm[ch];
    ym(s, port, (uint8_t)(0xb0 + off), enc_b0(c));
    ym(s, port, (uint8_t)(0xb4 + off), 0xc0);
    for (int slot = 0; slot < 4; slot++) {
      uint8_t oo = (uint8_t)(MML_OP_ADDR_OFFSET[slot] + off);
      MMLOp *o = &c->ops[slot];
      ym(s, port, (uint8_t)(0x30 + oo), enc_30(o));
      ym(s, port, (uint8_t)(0x40 + oo), 0);
      ym(s, port, (uint8_t)(0x50 + oo), 31);
      ym(s, port, (uint8_t)(0x60 + oo), 0);
      ym(s, port, (uint8_t)(0x70 + oo), 0);
      ym(s, port, (uint8_t)(0x80 + oo), enc_80(o));
      ym(s, port, (uint8_t)(0x90 + oo), 0);
    }
  }
  ym(s, 0, 0x22, 0); /* LFO off */
  ym(s, 0, 0x27, 0); /* CH3 normal mode, timers off */
  ym(s, 0, 0x2a, 0); /* DAC data centred — shadow only, the mixer owns it */
  ym(s, 0, 0x2b, 0); /* DAC off — likewise */
}

/* rescomp hands the host a bare `const u8[]` with no length, so the container
 * has to say how big it is: the end of the last section is the end of the file.
 * `max_len` is only a sanity bound — pass the ROM size, or 0 for none. */
uint32_t mml_mmb_size(const uint8_t *mmb, uint32_t max_len) {
  if (!mmb || mmb[0] != MAGIC0 || mmb[1] != MAGIC1 || mmb[2] != MAGIC2 ||
      mmb[3] != MAGIC3)
    return 0;
  uint16_t section_count = rd16(mmb, 8), header_size = rd16(mmb, 10);
  uint32_t end = header_size + (uint32_t)section_count * 12;
  for (uint16_t i = 0; i < section_count; i++) {
    uint32_t at = header_size + (uint32_t)i * 12;
    uint32_t off = rd32(mmb, at + 4), size = rd32(mmb, at + 8);
    if (off + size > end) end = off + size;
  }
  if (max_len && end > max_len) return 0;
  return end;
}

int mml_load(MMLSeq *s, const uint8_t *mmb, uint32_t len) {
  mml_zero(s, (uint32_t)sizeof(*s));
  if (len < 12 || mmb[0] != MAGIC0 || mmb[1] != MAGIC1 || mmb[2] != MAGIC2 ||
      mmb[3] != MAGIC3)
    return -1;
  uint16_t section_count = rd16(mmb, 8), header_size = rd16(mmb, 10);
  const uint8_t *track_table = 0;
  uint32_t track_table_len = 0;
  for (uint16_t i = 0; i < section_count; i++) {
    uint32_t at = header_size + (uint32_t)i * 12;
    uint16_t id = rd16(mmb, at);
    uint32_t off = rd32(mmb, at + 4), size = rd32(mmb, at + 8);
    if (off + size > len) return -2;
    if (id == SEC_TRACK_TABLE) { track_table = mmb + off; track_table_len = size; }
    else if (id == SEC_EVENT_STREAM) { s->stream = mmb + off; s->stream_len = size; }
    else if (id == SEC_VAL_TABLE && size >= 2) {
      uint16_t vn = rd16(mmb, off);
      if (vn > 16) vn = 16;
      for (uint16_t k = 0; k < vn; k++)
        s->val[k] = (int16_t)rd16(mmb, off + 2 + (uint32_t)k * 2);
    }
    else if (id == SEC_VOICE_TABLE && size >= 2) {
      s->voice_count = rd16(mmb, off);
      s->voices = mmb + off + 2;
    }
    else if (id == SEC_MACRO_TABLE && size >= 2) {
      s->macro_table = mmb + off;
      s->macro_count = rd16(mmb, off);
    }
  }
  if (!track_table || !s->stream || track_table_len < 2) return -3;

  uint16_t n = rd16(track_table, 0);
  if (n > MML_MAX_TRACKS) n = MML_MAX_TRACKS;
  s->track_count = (uint8_t)n;
  for (uint16_t i = 0; i < n; i++) {
    uint32_t at = 2 + (uint32_t)i * 5;
    s->trk[i].track_id = track_table[at];
    s->trk[i].channel_id = track_table[at + 1];
    s->trk[i].flags = track_table[at + 2];
    s->trk[i].event_offset = rd16(track_table, at + 3);
    s->trk[i].pc = s->trk[i].event_offset;
  }

  s->increment = (uint16_t)((120 * 512 + 37) / 75); /* bpmToTickIncrement(120) */
  s->master = VOL_UNITY;
  s->noise_mode = 4; /* white0; the compiler emits an explicit tick-0 set */
  for (int ch = 0; ch < 6; ch++) {
    MMLFmCh *c = &s->fm[ch];
    c->algorithm = 7;
    c->vel = 15;
    c->vol = VOL_UNITY;
    c->gate = 8;
    c->current_note = 60;
    for (int o = 0; o < 4; o++) {
      c->ops[o].ar = 31;
      c->ops[o].rr = 15;
      c->ops[o].mul = 1;
    }
  }
  for (int p = 0; p < 4; p++) {
    s->psg[p].vel = 15;
    s->psg[p].vol = VOL_UNITY;
    s->psg[p].gate = 8;
    s->psg[p].current_note = 60;
  }
  for (int v = 0; v < MML_PCM_VOICES; v++) {
    s->pcm[v].vel = 15;
    s->pcm[v].vol = VOL_UNITY;
    s->pcm[v].sent_shift = 0xff; /* no PCM_VOL sent yet */
  }
  emit_init_writes(s);
  return 0;
}

int mml_load_samples(MMLSeq *s, const uint8_t *bank, uint32_t len) {
  if (!bank || (len && len < 2)) return -1;
  uint16_t n = rd16(bank, 0);
  if (len && 2 + (uint32_t)n * 20 > len) return -2;
  s->sample_count = n;
  s->sample_entries = bank + 2;
  /* Entry offsets are relative to the blob region, which follows the table. */
  s->sample_blob_base = 2 + (uint32_t)n * 20;
  return 0;
}

/* ── Host control (driver.md §6.5) ────────────────────────────────────────── */
void mml_key_off(MMLSeq *s, uint8_t channel_id) {
  channel_off(s, channel_id);
  /* Release a len=0 hold: the track's dispatcher resumes. */
  for (uint8_t i = 0; i < s->track_count; i++)
    if (s->trk[i].channel_id == channel_id && s->trk[i].held) s->trk[i].held = 0;
}
void mml_set_param(MMLSeq *s, uint8_t channel_id, uint8_t target, int value) {
  param_set(s, channel_id, target, value);
}
void mml_fade_track(MMLSeq *s, uint8_t track_id, uint16_t frames) {
  for (uint8_t i = 0; i < s->track_count; i++) {
    MMLTrack *t = &s->trk[i];
    if (t->track_id != track_id || !t->running) continue;
    if (frames == 0) {
      stop_track(s, t);
      return;
    }
    /* Bresenham vol ramp to 0 over `frames`, then stop — division-free. */
    t->fading = 1;
    t->fade_n = frames;
    t->fade_err = 0;
    t->fade_vol = read_param(s, t->channel_id, T_VOL);
    t->fade_cur = t->fade_vol;
    t->fade_frame = 0;
    return;
  }
}
void mml_set_val(MMLSeq *s, uint8_t slot, int16_t value) {
  if (slot < 16) s->val[slot] = value;
}

void mml_command(MMLSeq *s, uint8_t cmd, uint8_t a0, uint8_t a1, uint8_t a2) {
  switch (cmd) {
    case 0x01: mml_start_track(s, a0); break;
    case 0x02: mml_stop_track(s, a0); break;
    case 0x03: mml_key_off(s, a0); break;
    case 0x04: mml_set_param(s, a0, a1, (int8_t)a2); break;
    case 0x05: mml_fade_track(s, a0, a1); break;
    case 0x06: mml_set_val(s, a0, (int16_t)(a1 | (a2 << 8))); break;
    default: break; /* START_SE is plan-se.md's, still unported */
  }
}

void mml_start_all(MMLSeq *s) {
  for (uint8_t i = 0; i < s->track_count; i++) {
    s->trk[i].running = 1;
    s->trk[i].armed = 1; /* the armed frame, driver.md §4.2 */
    s->trk[i].gate_left = -1;
  }
}

/* ── Track lifecycle (driver.md §6.5, §2.2) ────────────────────────────────
 * Ported from drv-player's _startTrack with the SE branches left out: SE is
 * still unported (plan-se.md), and keeping this shaped like the reference is
 * what lets those branches drop in later without re-deciding the rest.
 */
void mml_start_track(MMLSeq *s, uint8_t track_id) {
  MMLTrack *t = 0;
  for (uint8_t i = 0; i < s->track_count; i++)
    if (s->trk[i].track_id == track_id) { t = &s->trk[i]; break; }
  if (!t) return;

  int ch = t->channel_id;
  /* Channel ownership. ch2 is the FM3 shared channel — its voice track and op1
   * coexist by design — and ids >= 10 (fm3-op, pcm) have no channel block, so
   * neither has an owner to displace. */
  if (ch < 10 && ch != 2) {
    for (uint8_t i = 0; i < s->track_count; i++) {
      MMLTrack *o = &s->trk[i];
      if (o != t && o->running && o->channel_id == ch) stop_track(s, o);
    }
    /* Claiming a channel resets its level state to defaults, so a track that
     * relies on the default velocity (no PARAM_SET of its own) sounds right
     * after stealing a channel someone else had faded. */
    if (ch < 6) {
      s->fm[ch].vel = 15;
      s->fm[ch].vol = VOL_UNITY;
      s->fm[ch].gate = 8;
    } else {
      s->psg[ch - 6].vel = 15;
      s->psg[ch - 6].vol = VOL_UNITY;
      s->psg[ch - 6].gate = 8;
    }
  }

  t->pc = t->event_offset;
  t->acc = 0;
  t->wait = 0;
  t->gate_left = -1;
  t->pending_off = 0;
  t->marker_id = 0;
  t->depth = 0;
  t->held = 0;
  t->fading = 0;
  t->running = 1;
  t->armed = 1; /* silent setup frame; the first dispatch is the next one */
}

void mml_stop_track(MMLSeq *s, uint8_t track_id) {
  for (uint8_t i = 0; i < s->track_count; i++)
    if (s->trk[i].track_id == track_id && s->trk[i].running)
      stop_track(s, &s->trk[i]);
}

/* ── Ring transport (driver.md §6.6) ───────────────────────────────────────
 * The policy half of MMLisp_frame: everything except the bus grab and the copy,
 * so the host gate covers the arithmetic that is easy to get wrong.
 */
uint8_t mml_pump(MMLSeq *s, uint8_t head, uint8_t tail, uint8_t depth,
                 MMLSlotSink sink, void *ctx) {
  if (depth < 2) return head; /* a one-slot ring can never hold anything */
  uint8_t slot[MML_SLOT_SIZE];
  /* Bounded by construction — at most depth-1 slots fit — but the counter also
   * means a corrupt tail cannot spin the 68k for a frame. */
  for (uint8_t guard = 0; guard < depth; guard++) {
    uint8_t next = (uint8_t)(head + 1 >= depth ? 0 : head + 1);
    if (next == tail) break; /* full: we are as far ahead as depth allows */
    uint32_t n = mml_render_frame(s, slot);
    sink(ctx, head, slot, (uint16_t)n);
    head = next;
  }
  return head;
}
