/* MMLispDRV sequencer — the 68000 half of the split (docs/driver.md §4, §6).
 *
 * This is the port of live/src/drv-player.js, which is its normative spec: the
 * gate (tools/c-gate.mjs, driver.md §12.2) runs both over the same MMB and
 * diffs the slot streams at zero tolerance. Where this file and the prose
 * disagree, drv-player.js wins.
 *
 * Deliberately plain C99 with no SGDK dependency, so it compiles for the host
 * as well as for m68k — that is what makes the gate cheap: no emulator, no
 * assembler, a debugger on both sides.
 *
 * Scope so far: M1 (driver.md §11) — the core opcode set, FM + PSG note paths,
 * the level model, pitch, loops/calls, tempo, the armed frame, and slot
 * emission through the real cap/spill queue. M2/M3 opcodes stop the track
 * fail-safe rather than being silently mis-decoded.
 */
#ifndef MMLISPSEQ_H
#define MMLISPSEQ_H

#include <stddef.h>
#include <stdint.h>

/* ── Build constants (driver.md §6.2) ─────────────────────────────────────── */
#define MML_SLOT_SIZE 256
#define MML_SLOT_MAX_WRITES 95 /* what the settled mixer leaves, §5.3.1 */
#define MML_MAX_TRACKS 16
#define MML_LOOP_DEPTH 4
#define MML_WRITE_QUEUE 1024 /* spill headroom; a score head peaks near 150 */

/* ── Constant tables (tables.c, generated) ────────────────────────────────── */
extern const uint16_t MML_FNUM_BLOCK[128];
extern const uint16_t MML_PSG_PERIOD[128];
extern const int16_t MML_VEL_TL4[16];
extern const int16_t MML_VOL_TL4[32];
extern const int16_t MML_VEL_PSG4[16];
extern const int16_t MML_VOL_PSG4[32];
extern const uint8_t MML_CARRIER_MASK[8];
extern const uint8_t MML_OP_ADDR_OFFSET[4];
extern const uint8_t MML_SIN_LUT[256];

typedef struct {
  uint8_t voiced_tl, tl;
  uint8_t ar, dr, d2r, rr, sl, rs, mul, ssg, amen;
  int8_t dt;
} MMLOp;

typedef struct {
  MMLOp ops[4];
  uint8_t algorithm, feedback, ams, fms;
  int8_t pan;
  uint8_t vel, vol, gate;
  uint8_t current_note;
  int16_t pitch_cents;
  uint8_t keyed;
} MMLFmCh;

typedef struct {
  uint8_t vel, vol, gate;
  uint8_t current_note;
  int16_t pitch_cents;
  uint8_t keyed;   /* a note is active */
  uint8_t sounding; /* attenuation < 15 */
} MMLPsgCh;

/* One sweep slot (driver.md §4 step 3). Two per channel, so a pitch glide and
 * a volume fade can run at once. */
typedef struct {
  uint8_t active;
  uint8_t target, curve_id, loop;
  int32_t from, to;
  uint16_t len, frame;
  uint16_t phase16, step16;
} MMLSweep;

typedef struct {
  uint8_t active;
  uint8_t curve_id;
  int32_t from, to;
  uint16_t len, frame;
  uint16_t phase16, step16;
} MMLGlobalSweep;

typedef struct {
  uint16_t resume_pc;
  int16_t remaining; /* -1 tags a CALL frame; LOOP frames carry the count */
} MMLCtrl;

typedef struct {
  uint8_t running, armed, held;
  uint8_t track_id, channel_id, flags;
  uint16_t pc;
  uint16_t acc;      /* 8.8 tick accumulator */
  int32_t wait;      /* ticks until the next timed dispatch */
  int32_t gate_left; /* -1 = none */
  uint8_t pending_off;
  uint8_t marker_id;
  /* FADE_TRACK: a division-free Bresenham vol ramp to 0, then stop (§6.5). */
  uint8_t fading;
  uint16_t fade_n, fade_frame;
  int32_t fade_vol, fade_err, fade_cur;
  MMLCtrl ctrl[MML_LOOP_DEPTH];
  uint8_t depth;
} MMLTrack;

typedef struct {
  const uint8_t *stream;
  uint32_t stream_len;
  const uint8_t *voices; /* VOICE_TABLE payload: N x 29-byte entries */
  uint16_t voice_count;
  uint16_t increment; /* 8.8, per song (driver.md §3.2) */

  MMLTrack trk[MML_MAX_TRACKS];
  uint8_t track_count;

  MMLFmCh fm[6];
  MMLPsgCh psg[4];
  uint8_t master;
  uint8_t noise_mode;
  uint8_t lfo_rate;
  uint8_t reg27; /* CH3/CSM mode register (bit7 CSM, bit6 special) */

  MMLSweep sweeps[10][2];
  MMLGlobalSweep tempo_sweep;
  MMLGlobalSweep csm_sweep;
  int16_t val[16]; /* VAL_TABLE seed; slot 0xFF is $time, never stored here */

  /* Change-only shadow, driver.md §4. Post-split this lives HERE, not on the
   * Z80 — which is what removed ~550 cycles of bookkeeping per write there.
   *
   * `shadow_set` is the "has this register ever been written" plane. It looks
   * redundant — the neutral patch covers every register anything writes — but
   * without it a FIRST write of 0 would compare equal to a zero-initialised
   * entry and be suppressed, and the patch is full of zeroes. The reference
   * gets this for free by keying a Map (missing != 0); the Z80 got it by
   * writing every covered register at boot, which is what let it drop the
   * plane entirely. */
  uint8_t shadow[2][256];
  uint8_t shadow_set[2][256];

  /* The cap/spill queue. Excess writes keep their order and lead the next
   * slot: the transport may delay a write, never reorder or drop one. */
  struct {
    uint8_t port, addr, data;
  } q[MML_WRITE_QUEUE];
  uint16_t q_head, q_tail;
  uint16_t spill_peak, spill_frames;

  uint32_t frame;
  uint8_t stopped;    /* a track hit something this port cannot decode */
  uint8_t stopped_op; /* which opcode it was — the port's to-do list, in order */
  uint32_t stopped_frame;
} MMLSeq;

/* Load an MMB. Returns 0 on success, negative on a malformed file. */
int mml_load(MMLSeq *s, const uint8_t *mmb, uint32_t len);

/* Start every track (what the gate harness does; the real host starts them
 * individually through the API driver.md §6.5 describes). */
void mml_start_all(MMLSeq *s);

/* Render one frame and close its slot. Returns the slot length in bytes. */
uint32_t mml_render_frame(MMLSeq *s, uint8_t *slot_out);

/* Writes still queued behind the cap. */
uint16_t mml_pending(const MMLSeq *s);

/* Every track idle or held. */
int mml_done(const MMLSeq *s);

/* ── Host control (driver.md §6.5) ─────────────────────────────────────────
 * These execute IN the sequencer rather than being posted to it, so they take
 * effect on the next frame rendered — and are therefore heard RING_DEPTH
 * frames later (§3.4). */
void mml_key_off(MMLSeq *s, uint8_t channel_id);
void mml_set_param(MMLSeq *s, uint8_t channel_id, uint8_t target, int value);
void mml_fade_track(MMLSeq *s, uint8_t track_id, uint16_t frames);
void mml_set_val(MMLSeq *s, uint8_t slot, int16_t value);

/* Dispatch one host command by the v0.2 mailbox numbering. The transport is
 * gone — these are ordinary calls now — but the numbering survives so the gate
 * corpus's command schedules keep working unchanged. */
void mml_command(MMLSeq *s, uint8_t cmd, uint8_t a0, uint8_t a1, uint8_t a2);

#endif /* MMLISPSEQ_H */
