/* MMLispDRV — the slot stream turned into the pair transport (R28 §63.3 D7).
 *
 * The sequencer (mmlispseq.c) still renders one SLOT a frame — the write lists
 * per port and the PCM commands docs/driver.md §6.2 describes, gated against the
 * JS reference byte for byte. This module is what the host does with a slot
 * now that the Z80 consumes {op, val} PAIRS instead of slots:
 *
 *   FM writes    -> pairs, with a PORT pair where the port changes and a
 *                   pitch pair ($A4-$A6 then $A0-$A2, either port) kept whole
 *   PCM commands -> pairs into the engine's state block: a start is the window
 *                   address, `end - 16 * step`, the step, a level page and a
 *                   new generation; a stop a new stop generation. One slot
 *                   late, to undo the sequencer's one-frame PCM lead
 *   PSG bytes    -> a queue the host writes straight to $C00011, one grab
 *                   period late so they land with the FM they were cued with
 *
 * Portable C99 with no SGDK dependency, like the sequencer, so it is gated on
 * the host against its JS twin (tools/pairs-model.mjs, `npm run pairs-gate`).
 */
#ifndef MMLPAIRS_H
#define MMLPAIRS_H

/* The same type source as mmlispseq.h: SGDK's own under SGDK_GCC, the
 * standard header on the host. Pulling <stdint.h> into an SGDK build collides
 * with types.h's s8. */
#ifdef SGDK_GCC
#include <types.h>
#else
#include <stdint.h>
#endif
#include "mmlispseq.h"   /* MMLSeq, MMLFrameView: mmlp_render reads the sequencer */

/* What the engine image's header says (sgdk/mmlispdrv_bin.h); passed in so
 * this file compiles on the host without SGDK's types. */
typedef struct {
  uint16_t fifo;         /* the pair page in Z80 RAM */
  uint8_t fifo_pairs;    /* 128 */
  uint8_t pairs_per_grab;/* 5 */
  uint8_t lut_page;      /* the level family's first page */
  uint8_t levels;        /* 15 */
  uint8_t op_limit;      /* ops below this store into the state block */
  uint8_t op_idle, op_level, op_master, op_src_lo, op_src_hi, op_end_lo, op_end_hi;
  uint8_t op_step, op_start, op_stop, op_port;
  uint8_t staged_run;    /* set by mmlp_init: src lo..step are consecutive ops */
} MMLPairsCfg;

#define MMLP_QUEUE 1024   /* pairs the host holds while the wire catches up */
#define MMLP_PSG   256    /* PSG bytes held for one grab period */
#define MMLP_HELD  128    /* one slot's PCM commands, held for the next slot */
#define MMLP_FRAMES 8     /* frames queued ahead whose ends are remembered (a power of two) */

typedef struct {
  MMLPairsCfg cfg;
  /* The pair queue: {port, reg, val} entries, port 0xff for a state store. */
  uint8_t q_port[MMLP_QUEUE], q_op[MMLP_QUEUE], q_val[MMLP_QUEUE];
  uint16_t q_head, q_tail;
  uint16_t q_work;       /* the producer's cursor while a slot is taken apart */
  /* The PSG queue, released one grab late. */
  uint8_t psg[MMLP_PSG];
  uint16_t psg_head, psg_tail, psg_mark, psg_work;
  /* FRAMES. Slot k is frame k; where each queued frame ends in both queues,
   * so a grab sends only the frames whose time has come (mmlp_plan). */
  uint16_t frames_in;               /* slots taken in: the next slot's frame number */
  uint16_t end_q[MMLP_FRAMES], end_psg[MMLP_FRAMES];
  /* The previous slot's PCM commands, sent with this one (mmlpairs.c). */
  uint8_t held[MMLP_HELD];
  uint16_t held_len;
  /* The producer's state. */
  uint8_t chip_port;     /* the port the engine's RAW arm currently writes */
  uint8_t start_gen, stop_gen;
  uint8_t head;          /* H: the next pair position in the page (0..127) */
  uint8_t head_valid;    /* H has been placed relative to a read index */
  uint8_t level_page, master_page;
  uint8_t staged[5];     /* src lo/hi, end lo/hi, step as last sent */
  uint8_t staged_valid;  /* ...once a start has sent them all */
  uint8_t since_start;   /* pairs planned since the last START pair (saturating) */
  /* Counters a host can show. */
  uint16_t dropped_voice;  /* PCM commands for voices this profile has not */
  uint16_t dropped_loop;   /* PCM_LOOP commands (no loops in profile 1) */
  uint16_t step_rounded;   /* starts whose increment was not a power of two */
  uint16_t overflow;       /* pairs that did not fit the queue */
  uint16_t grabs, pairs_written;
  uint16_t late;           /* grabs that found the engine already past `dst` */
  /* What the last plan took, so a grab that turns out late can give it back. */
  uint16_t undo_tail;
  uint8_t undo_port, undo_n, undo_since;
} MMLPairs;

void mmlp_init(MMLPairs *p, const MMLPairsCfg *cfg);

/* Take one rendered slot apart into the queues. ONE PRODUCER, ONE CONSUMER:
 * mmlp_slot may run in the main loop while mmlp_plan / mmlp_psg_take run from
 * an interrupt. The producer publishes a whole slot with one store per queue,
 * and each side writes only its own cursor, so no lock is needed on a single
 * CPU whose interrupts run to completion. Two consumers must not overlap (the
 * SGDK host keeps a flag for that). */
void mmlp_slot(MMLPairs *p, const uint8_t *slot, uint16_t len);

/* The same, straight from the sequencer: run one frame (or drain one) and take
 * it into the queues without encoding a slot — what the SGDK host does, and
 * equal to mml_render_frame + mmlp_slot state for state (pairs-gate). */
void mmlp_render(MMLPairs *p, MMLSeq *s);
void mmlp_drain(MMLPairs *p, MMLSeq *s);

/* WHICH FRAMES MAY GO. `release` is how many frames' time has come: frames
 * 0 .. release-1 may be written, later ones wait even if they are queued. So
 * the host can render ahead (the SGDK host renders one frame early) and the
 * pairs still leave on their own frame — a render that runs late delays
 * nothing that was ready, and nothing goes out early. Frames more than
 * MMLP_FRAMES ahead of `release` must not be queued; `release` = frames_in
 * sends whatever is queued. Counts wrap at 16 bits and compare as such. */

/* Plan one grab. `fifo_lo` is the byte the engine publishes (its next pair's
 * byte offset into the page) as read in the PREVIOUS grab, or 0xff for none
 * yet. Fills `ops[k]` and `vals[k]` for the grab's pairs_per_grab positions —
 * the real pairs, then IDLE — and returns how many are real; `*dst` is the Z80
 * address of the first. Zero means nothing to write this time (the host still
 * reads fifo_lo), and then the arrays are left as they were. Two arrays, not
 * one interleaved run, because that is how the SGDK host stores them: MOVEP
 * writes every other byte of the page (mmlispdrv.c). */
uint16_t mmlp_plan(MMLPairs *p, uint8_t fifo_lo, uint16_t release, uint8_t *ops, uint8_t *vals, uint16_t *dst);

/* THE IN-GRAB TEST. The destination was chosen from the index read in the
 * PREVIOUS grab, ahead of it by more than the engine consumes between two
 * grabs at the normal spacing. A grab that comes late (an interrupt pump
 * skipped, a main loop that overran a frame) can find the engine already at or
 * past `dst`; pairs written there would wait a whole page cycle (~64 ms) and
 * the next grab's pairs, placed from a fresh index, would be read BEFORE them.
 * So the grab reads the index first and copies only when the engine has not
 * reached `dst`: the index moved by less than `dst` was ahead of it. One byte
 * subtraction and compare, with the bus held; everything else is planned. */
static inline int mmlp_in_time(uint8_t lo_prev, uint16_t dst, uint8_t lo_now) {
  return (uint8_t)(lo_now - lo_prev) < (uint8_t)((uint8_t)dst - lo_prev);
}

/* The grab was late and copied nothing: put the planned pairs back at the
 * front of the queue. Everything written before `dst` has been consumed (the
 * engine passed it), so the next plan places the head from the fresh index. */
void mmlp_abort(MMLPairs *p);

/* PSG bytes released for this grab period: those of released frames (as
 * mmlp_plan) that were already released at the previous call — one grab late,
 * so they land about when the FM they were cued with leaves the pair page.
 * Returns how many were copied into `out` (at most `max`). */
uint16_t mmlp_psg_take(MMLPairs *p, uint16_t release, uint8_t *out, uint16_t max);

/* Pairs still waiting. */
uint16_t mmlp_pending(const MMLPairs *p);

/* The level page a PCM shift maps to (6 dB grid onto the linear family). */
uint8_t mmlp_level_page(const MMLPairsCfg *cfg, uint8_t shift);
uint8_t mmlp_master_page(const MMLPairsCfg *cfg, uint8_t shift);

#endif
