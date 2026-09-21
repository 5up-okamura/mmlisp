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
/* Sub-ticks per frame (driver.md §3.5). ONE: note onsets are on the 60 Hz
 * frame, as in most game drivers. Sub-ticks were adopted as nearly free; with
 * the pair engine they were not heard (a frame's writes leave together) and
 * cost the 68000 ~6 points of its time (sin008: idle 71.9% -> 78.6% at 1), so
 * they were retired (2026-09-14). Must equal live/src/slot-builder.js. */
#define MML_SLOT_SUBS 1
#define MML_MAX_TRACKS 16
#define MML_LOOP_DEPTH 4
#define MML_WRITE_QUEUE 1024 /* spill headroom; a score head peaks near 150 */
/* Macros bound per channel (driver.md §13.1 budgets 3 — one per target family;
 * the extra room costs 2 bytes a slot and removes a silent-drop failure mode). */
#define MML_MACRO_BINDS 8
/* PCM voices (pcm1-pcm3). The score's own count picks the engine image
 * (driver.md §5); the sequencer keeps state for all three. */
#define MML_PCM_VOICES 3
/* How far a PCM voice is attenuated by vel + vol, in 6 dB steps. Above this
 * the level CLAMPS; `vol 0`, `master 0` and MML_PCM_TOTAL_MAX_SHIFT are the
 * hard mutes. Mirrors PCM_MAX_SHIFT in live/src/mmb.js. */
#define MML_PCM_MAX_SHIFT 4
/* Master's own ceiling (driver.md §14.1): the host folds it into each voice's
 * level page, so it may reach deeper than a voice's own. Mirrors
 * PCM_MASTER_MAX_SHIFT / PCM_TOTAL_MAX_SHIFT in live/src/mmb.js. */
#define MML_PCM_MASTER_MAX_SHIFT 6
/* Voice shift + master shift at which the voice is muted. */
#define MML_PCM_TOTAL_MAX_SHIFT 7
/* The engine images' rate stamps (MML_PCM_STAMP_1..3), which a sample bank
 * baked for the image must carry. Generated from live/src/engine-images.js. */
#include "mml_rate.h"
/* One v0.3 sample-bank entry (mmb.md §10). */
#define MML_SAMPLE_ENTRY 24
/* A block of the engine, and the window a voice reads through. */
#define MML_PCM_BLOCK 16
#define MML_PCM_WINDOW 0x8000u
#define MML_PCM_SILENCE 0xFF00u

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

/* Sweep banks: the ten M1 channels, the three PCM voices, then FM3's four
 * operators (channel ids 16-19) — a glide or pitch sweep on an fm3-N track
 * bends that operator alone (driver.md §13.4). sweep_bank() maps a channel id
 * to its bank. */
#define MML_SWEEP_BANKS 17
/* The channels the macro engine runs on: 0-9 and FM3's four operators
 * (macro_ch()). */
#define MML_MACRO_CHANNELS 14

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
  uint8_t fresh; /* the note's own frame: a KEYON step here does not re-attack */
  uint16_t cursor;
  int16_t step_clock; /* frames left on this step; signed, a step of 0 free-runs */
} MMLMacroSlot;

/* One register write in the cap/spill queue: port 0/1 = YM part, 2 = PSG. */
typedef struct {
  uint8_t port, addr, data;
} MMLWrite;

/* One descriptor, decoded from MACRO_TABLE on demand (mmb.md §15). Held by
 * pointer rather than copied: the table is ROM on the target. */
typedef struct {
  uint8_t target, flags, step, loop_start, release, count;
  const uint8_t *values;
  uint8_t scale_slot, has_scale;
} MMLMacro;

/* ── PCM voice (driver.md §14) ─────────────────────────────────────────────
 * The engine owns playback — every pointer is the Z80's — so the sequencer
 * keeps only what its commands need: the note's blob, whether it loops (a
 * note-off sends its release), the loop, and the level. */
typedef struct {
  uint8_t started;    /* a START has been sent since load: PCM_VOL is worth sending */
  uint8_t looping;    /* the running note loops */
  uint8_t muted;
  uint16_t src;       /* the note's blob, as a window address */
  uint16_t len;       /* …and its length in bytes (whole blocks) */
  uint8_t vel_base, vel, vol;
  uint8_t shift;      /* composed attenuation 0..4; master is folded in by the host */
  uint8_t sent_shift; /* last shift byte sent, 0xFF = none */
  /* THE LIVE LOOP, in baked bytes from the blob's start, unrounded — the note's
   * own points until a LOOP_START/LOOP_END/LOOP_LEN param moves them. The
   * length is kept beside the end so that moving only the start slides a loop
   * of the same length through the sample, which is the gesture that spelling
   * exists for; :loop-end pins the end instead and sets end_fixed. */
  uint32_t ls, le, llen;
  uint8_t end_fixed;
  /* The last END/WRAP sent. A sweep runs every frame and mostly lands on the
   * same 16-byte block, so a RETARGET goes out only when the block changes. */
  uint16_t sent_end, sent_wrap;
  uint8_t sent_pts;
  /* THE TRACK'S OWN LOOP WRITES, sticky like any other track parameter: a loop
   * note starts from the def's loop with these laid over it, so a :loop-start
   * written before the note is the note's. o_kind: 0 none, else the last of
   * T_LOOP_END / T_LOOP_LEN written, with its value in o_bound. */
  uint8_t o_has_ls, o_kind;
  uint32_t o_ls, o_bound;
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
  uint8_t trig_byte; /* game-readable trig status (opcodes.md 0x42) */
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
  /* The score's PCM voice count (MMB header flags bits 2-3): which engine image
   * plays it, and so the rate stamp its bank must carry. */
  uint8_t pcm_voices;
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
  /* Master's own shift, and the last value sent as PCM_MASTER. See
   * pcm_compose_master. */
  uint8_t pcm_master_shift;
  uint8_t pcm_sent_master;
  uint8_t noise_mode;
  uint8_t lfo_rate;
  uint8_t reg27;       /* CH3/CSM mode register (bit7 CSM, bit6 special) */
  uint8_t fm3_op_mask; /* FM3 independent-OP key bits (0x10..0x80 -> $28) */

  MMLSweep sweeps[MML_SWEEP_BANKS][2];
  MMLMacroBind binds[MML_MACRO_CHANNELS][MML_MACRO_BINDS];
  uint8_t bind_count[MML_MACRO_CHANNELS];
  MMLMacroSlot macro_slots[MML_MACRO_CHANNELS][MML_MACRO_BINDS];
  uint8_t macro_slot_count[MML_MACRO_CHANNELS];
  /* FM3 independent-OP mode: each operator's own note and sticky :pitch
   * offset (index = op - 1). In special mode these, not fm[2]'s, are what the
   * operator's F-number is written from (driver.md §13.4). */
  uint8_t fm3_op_note[4];
  int16_t fm3_op_cents[4];
  /* ...and its own level. Composed with the shared CH3's vol — the group fader
   * the note-less `(fm3 …)` track writes — and the global master into that
   * operator's TL (driver.md §13.4). */
  uint8_t fm3_op_vel[4], fm3_op_vel_base[4], fm3_op_vol[4];
  MMLPcmVoice pcm[MML_PCM_VOICES];
  uint8_t pcm_dac_on;  /* $2B sent: the score's first PCM note claims fm6 for good */
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
  MMLWrite q[MML_WRITE_QUEUE];
  uint16_t q_head, q_tail;
  /* Queue depth at each sub-tick boundary — where one sub-slot's run ends and
   * the next begins. Recorded as a COUNT, not an index, so the ring's wrap
   * never has to be reasoned about at encode time. */
  uint16_t sub_mark[MML_SLOT_SUBS];
  uint16_t spill_peak, spill_frames;

  /* PCM commands for the frame being built (§6.3). NOT capped — they are the
   * frame's decisions, not its register traffic — but they count against the
   * slot's byte budget. */
  uint8_t pcm_buf[MML_SLOT_SIZE];
  uint16_t pcm_len;
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
 * address space — a voice's window address depends on where the blob was
 * linked. Returns 0 on success, -3 for a bank baked for another engine image,
 * other negatives for a bad table. */
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
/* Run every idle track's leading setup now, so its writes reach the chip
 * before the track is started (host command 0x08; see mmlispseq.c). Starting
 * a primed track later is an ordinary start whose setup finds the registers
 * already set. */
void mml_prime_tracks(MMLSeq *s);
void mml_stop_track(MMLSeq *s, uint8_t track_id);

/* Render one frame and close its slot. Returns the slot length in bytes. */
uint32_t mml_render_frame(MMLSeq *s, uint8_t *slot_out);

/* Close a slot WITHOUT running a frame — how the spill queue is drained once
 * the song is over. Returns the slot length in bytes. */
uint32_t mml_drain_frame(MMLSeq *s, uint8_t *slot_out);

/* THE FRAME AS A VIEW — what mml_render_frame / mml_drain_frame would encode,
 * described instead of written: the slot's PCM commands, and for each
 * sub-slot the run of the write queue it takes (entries first .. first+end[j],
 * wrapping at MML_WRITE_QUEUE; sub-slot j starts where j-1 ended). For a host
 * whose consumer is on the 68000 side (the SGDK pair host) the bytes were
 * only ever unpacked again. The queue and the PCM run stay as they are until
 * mml_view_done; call it before the next frame. */
typedef struct {
  const MMLWrite *q;
  uint16_t first;
  uint16_t end[MML_SLOT_SUBS];
  const uint8_t *pcm;
  uint16_t pcm_len;
  uint8_t pcm_count;
} MMLFrameView;
void mml_render_frame_view(MMLSeq *s, MMLFrameView *v);
void mml_drain_frame_view(MMLSeq *s, MMLFrameView *v);
void mml_view_done(MMLSeq *s, const MMLFrameView *v);

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
