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
 * Scope so far: M1 + M2 + M3 (driver.md §11) — the core opcode set, FM + PSG
 * note paths, the level model, pitch, loops/calls, tempo, the armed frame, slot
 * emission through the real cap/spill queue, the sweep engine and host API, and
 * now the macro engine, the value machine's stream ops, FM3 independent-OP mode
 * and PCM command emission. Anything still unported stops the track fail-safe
 * rather than being silently mis-decoded.
 */
#ifndef MMLISPSEQ_H
#define MMLISPSEQ_H

/* Fixed-width types, from whichever source this translation unit is allowed.
 *
 * SGDK's <types.h> #DEFINES `uint8_t`, `int8_t`, `size_t` and friends as MACROS
 * over its own u8/s8 types. Once <genesis.h> has been seen, pulling in
 * <stdint.h> is therefore a hard error — the standard header goes on to declare
 * names that are no longer identifiers. So on that target we take SGDK's, which
 * supply every fixed-width name this file uses; everywhere else (the host gate)
 * the standard headers. SGDK defines SGDK_GCC on the command line. */
#ifdef SGDK_GCC
#include <types.h>
/* SGDK's s8 — and therefore int8_t here — is plain `char`, whose signedness is
 * implementation-defined. Every signed 8-bit value in this file depends on it
 * (operator detune, macro samples), and getting it wrong would be an audible
 * bug rather than a crash. Make it a compile error instead. */
typedef char mml_assert_char_is_signed[(char)-1 < 0 ? 1 : -1];
#else
#include <stdint.h>
#endif

/* ── Build constants (driver.md §6.2) ─────────────────────────────────────── */
#define MML_SLOT_SIZE 256
#define MML_SLOT_MAX_WRITES 95 /* what the settled mixer leaves, §5.3.1 */
/* Longest segment run a slot carries per voice. A voice that breaks more often
 * than this — a loop under ~11 mix ticks long — simply runs out of plan, and
 * the engine falls back to one-tick segments for the rest of its pass: correct,
 * slower, and never reached by real material. */
#define MML_PCM_PLAN_MAX 16
/* Sub-ticks per frame (driver.md §3.5). Note dispatch runs on every one of
 * them; the engines still run once a frame. Must match the engine's SLOT_SUBS
 * and PACE_PASSES — the Z80 consumes the extra sub-slots on the mixer's voice
 * pass boundaries, and there are exactly three of those. */
#define MML_SLOT_SUBS 2
#define MML_MAX_TRACKS 16
#define MML_LOOP_DEPTH 4
#define MML_WRITE_QUEUE 1024 /* spill headroom; a score head peaks near 150 */
/* Macros bound per channel (driver.md §13.1 budgets 3 — one per target family;
 * the extra room costs 2 bytes a slot and removes a silent-drop failure mode). */
#define MML_MACRO_BINDS 8
#define MML_PCM_VOICES 2
/* The Timer-B sample clock (driver.md §5.1.2), mirroring live/src/mmb.js. The
 * DAC's rate is the YM's, not the frame's: 37335/224 = 166.674 samples a frame,
 * so a frame owes it 166 or 167 and never a constant. The mixer produces into a
 * ring instead of a frame-long buffer, and the sequencer models the ring's fill
 * because the segment plan's tick distances are only valid for the chunk length
 * it planned them against. */
#define MML_PCM_SAMPLES_NUM 37335
#define MML_PCM_SAMPLES_DEN 224
/* Finished samples the ring runs ahead of the feed. A burst's first frame
 * builds all of them and feeds nothing; every frame after it mixes exactly what
 * the feed took. (The engine's buffer is twice this — §5.1.2.) */
#define MML_PCM_RING_TARGET 255 /* a pass's tick count is a byte on the Z80 */

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
extern const uint16_t MML_PCM_MULT_FRAME[49];

typedef struct {
  uint8_t voiced_tl, tl;
  uint8_t ar, dr, d2r, rr, sl, rs, mul, ssg, amen;
  int8_t dt;
} MMLOp;

typedef struct {
  MMLOp ops[4];
  uint8_t algorithm, feedback, ams, fms;
  int8_t pan;
  /* vel is TWO values (driver.md §7.1): vel_base is the score's sticky
   * velocity, written only by a PARAM_SET VEL out of the stream; vel is the
   * live one a macro drives. note_on copies base -> live. */
  uint8_t vel_base, vel, vol, gate;
  uint8_t current_note;
  int16_t pitch_cents;
  uint8_t keyed;
} MMLFmCh;

typedef struct {
  uint8_t vel_base, vel, vol, gate;
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

/* ── Macro engine (driver.md §13) ──────────────────────────────────────────
 * MACRO_SET binds a macro to its target on the channel and is STICKY: the bind
 * survives notes, and every NOTE_ON re-instantiates the whole active set into
 * fresh running slots. So a channel carries two things — the binds (what is
 * armed) and the slots (what is currently stepping). */
typedef struct {
  uint8_t target, macro_id;
} MMLMacroBind;

enum { MML_MACRO_RUN = 0, MML_MACRO_HOLD = 1, MML_MACRO_RELEASE = 2 };

typedef struct {
  uint8_t macro_id;
  uint8_t state; /* MML_MACRO_RUN / _HOLD / _RELEASE */
  uint8_t dead;  /* finished this frame; compacted after the pass */
  uint16_t cursor;
  int16_t step_clock; /* frames left on this step; signed, a step of 0 free-runs */
} MMLMacroSlot;

/* One descriptor, decoded from MACRO_TABLE on demand (mmb.md §15). Held by
 * pointer rather than copied: the table is ROM on the target. */
typedef struct {
  uint8_t target, flags, step, loop_start, release, count;
  const uint8_t *values;
  uint8_t scale_slot, has_scale;
} MMLMacro;

/* ── PCM soft-mix voice (driver.md §14) ────────────────────────────────────
 * The 68k does not mix — it only decides. But it does shadow each voice's
 * POSITION, because two of its own decisions depend on when a voice ends: a
 * PCM_VOL for a dead voice is not worth the slot bytes, and PCM_NOTE_OFF on a
 * finished shot must emit nothing. The Z80 runs the same countdown over the
 * same 16.16 increment, so the two agree tick for tick. */
typedef struct {
  uint8_t active, has_loop, releasing, muted;
  uint32_t base, len, loop_start, loop_end, loop_len;
  int32_t left; /* bytes to the current boundary, counted down (§6.3) */
  int32_t tail; /* loop end -> sample end, added to `left` on release */
  uint32_t inc; /* 16.16 samples per mix tick */
  uint32_t pos;
  uint8_t vel_base, vel, vol;
  uint8_t shift;      /* composed attenuation; the mixer sra's by it */
  uint8_t sent_shift; /* last PCM_VOL byte sent, 0xFF = none */
} MMLPcmVoice;

typedef struct {
  uint8_t running, armed, held;
  /* The frame the armed setup ran in. The armed frame advances no ticks at ALL
   * of its sub-ticks, not only the one that ran the setup (driver.md §3.5). */
  uint32_t armed_frame;
  uint8_t track_id, channel_id, flags;
  uint16_t event_offset; /* stream start, for a restart */
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
  const uint8_t *macro_table; /* MACRO_TABLE section, descriptors then blob */
  uint16_t macro_count;
  /* SAMPLE_BANK (mmb.md §10) — a separate ROM bank, not an MMB section. Only
   * the entry table is the sequencer's business; the blob belongs to the Z80. */
  const uint8_t *sample_entries;
  uint16_t sample_count;
  uint32_t sample_blob_base;
  /* Where the bank sits in the 68k ADDRESS SPACE. The Z80 reaches samples
   * through its 32 KB window, so PCM_START must carry an absolute {bank,
   * offset} — and only the host knows where rescomp put the blob. The gate
   * passes 0, which is what drv-player's _sampleBankBase models. */
  uint32_t sample_rom_base;
  uint16_t increment; /* 8.8, per song (driver.md §3.2) */

  MMLTrack trk[MML_MAX_TRACKS];
  uint8_t track_count;

  MMLFmCh fm[6];
  MMLPsgCh psg[4];
  uint8_t master;
  uint8_t noise_mode;
  uint8_t lfo_rate;
  uint8_t reg27;       /* CH3/CSM mode register (bit7 CSM, bit6 special) */
  uint8_t fm3_op_mask; /* FM3 independent-OP key bits (0x10..0x80 -> $28) */

  MMLSweep sweeps[10][2];
  MMLMacroBind binds[10][MML_MACRO_BINDS];
  uint8_t bind_count[10];
  MMLMacroSlot macro_slots[10][MML_MACRO_BINDS];
  uint8_t macro_slot_count[10];
  MMLPcmVoice pcm[MML_PCM_VOICES];
  uint8_t pcm_dac_on;
  uint16_t pcm_fill;  /* samples mixed into the ring and not yet fed (§5.1.2) */
  uint8_t pcm_chunk;  /* samples this frame's slot tells the engine to mix; 0 = prime */
  uint16_t pcm_sched; /* remainder of the sample clock's 166.674 a frame */
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
  /* Queue depth at each sub-tick boundary — where one sub-slot's run ends and
   * the next begins. Recorded as a COUNT, not an index, so the ring's wrap
   * never has to be reasoned about at encode time. */
  uint16_t sub_mark[MML_SLOT_SUBS];
  uint16_t spill_peak, spill_frames;

  /* PCM commands for the frame being built. They ride the slot's fourth run
   * (§6.2) and are NOT capped — they are the frame's decisions, not its
   * register traffic — but they do count against the slot's byte budget. */
  uint8_t pcm_buf[MML_SLOT_SIZE];
  uint16_t pcm_len;
  /* The frame's segment plan (driver.md §6.3.1): one count-prefixed run per
   * PCM voice, giving the ticks from one logical break to the next. Built by
   * the position advance the sequencer runs anyway. */
  uint8_t plan_buf[MML_PCM_VOICES * (MML_PCM_PLAN_MAX + 1)];
  uint16_t plan_len;
  uint8_t pcm_count;

  uint32_t frame;
  uint8_t sub;        /* which sub-tick of the frame is dispatching (§3.5) */
  uint8_t stopped;    /* a track hit something this port cannot decode */
  uint8_t stopped_op; /* which opcode it was — the port's to-do list, in order */
  uint32_t stopped_frame;
} MMLSeq;

/* Load an MMB. Returns 0 on success, negative on a malformed file. */
int mml_load(MMLSeq *s, const uint8_t *mmb, uint32_t len);

/* Attach the sample bank (mmb.md §10) — a separate ROM bank, so it is a
 * separate call. Must follow mml_load, which clears the whole state. Scores
 * without PCM never make it. `len` bounds the table; pass 0 when the caller has
 * only a ROM pointer and no size. `rom_base` is the bank's address in the 68k
 * address space — PCM_START carries an absolute {bank, window offset} and only
 * the host knows where the blob was linked. Returns 0 on success, negative on a
 * bad table. */
int mml_load_samples(MMLSeq *s, const uint8_t *bank, uint32_t len, uint32_t rom_base);

/* True when the loaded score plays PCM but no sample bank is attached — the
 * one configuration that fails ENTIRELY silently (every PCM note dropped, the
 * DAC never even enabled, sounding exactly like a missing part). Worth showing
 * on screen rather than letting someone chase it. */
int mml_needs_samples(const MMLSeq *s);

/* Total MMB length, derived from its own section table. The host gets a bare
 * pointer out of rescomp with no size attached, so the container tells it. */
uint32_t mml_mmb_size(const uint8_t *mmb, uint32_t max_len);

/* Start every track (what the gate harness does; the real host starts them
 * individually through the API driver.md §6.5 describes). */
void mml_start_all(MMLSeq *s);

/* Start one track by its MMB track id (driver.md §6.5): re-init its dispatch
 * state, apply the channel-ownership rule (§2.2 — the current owner is evicted),
 * reset the channel's level state to defaults, and enter the armed frame (§4.2).
 * Starting an already-running track restarts it from the top. */
void mml_start_track(MMLSeq *s, uint8_t track_id);

/* Stop one track: key-off (the release tail runs out), free its channel, idle
 * the TCB. On an fm3-csm track this clears the CSM bit (§9). */
void mml_stop_track(MMLSeq *s, uint8_t track_id);

/* Render one frame and close its slot. Returns the slot length in bytes. */
uint32_t mml_render_frame(MMLSeq *s, uint8_t *slot_out);

/* Close a slot WITHOUT running a frame — how the spill queue is drained once
 * the song is over. Returns the slot length in bytes. */
uint32_t mml_drain_frame(MMLSeq *s, uint8_t *slot_out);

/* ── Ring transport (driver.md §6.1, §6.6) ─────────────────────────────────
 * The bus grab and the byte copy belong to the host layer; the arithmetic that
 * decides HOW MANY slots to render belongs here, where the host gate can reach
 * it. `mml_pump` renders while the ring has space and hands each slot to
 * `sink`, returning the new head — which the caller publishes LAST, after the
 * bytes are in place.
 *
 * `head == tail` is empty, so a depth-N ring holds N-1 slots, which is exactly
 * §3.4's "at depth N the game may overrun N-1 frames". The call is therefore
 * self-limiting: a second call in the same frame finds no space and renders
 * nothing (§6.6). */
typedef void (*MMLSlotSink)(void *ctx, uint8_t index, const uint8_t *bytes,
                            uint16_t len);
uint8_t mml_pump(MMLSeq *s, uint8_t head, uint8_t tail, uint8_t depth,
                 MMLSlotSink sink, void *ctx);

/* Writes still queued behind the cap. */
uint16_t mml_pending(const MMLSeq *s);

/* The loaded score's tracks. The MMB knows how many there are and what their
 * ids are, so nothing downstream should be hardcoding either: a count that
 * stops short of the list silently never starts the tail of it, and PCM tracks
 * tend to sit at the end. */
uint8_t mml_track_count(const MMLSeq *s);
uint8_t mml_track_id(const MMLSeq *s, uint8_t index);

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
