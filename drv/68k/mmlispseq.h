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
 * now the macro engine, the value machine's stream ops, FM3 independent-OP mode,
 * PCM command emission and SE (suspend / restore, priority). Anything still
 * unported stops the track fail-safe rather than being silently mis-decoded.
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
 * cost the 68000 ~6 points of its time (a six-channel FM+PSG+PCM song: idle
 * 71.9% -> 78.6% at 1), so they were retired (2026-09-14). Must equal
 * live/src/slot-builder.js. */
#define MML_SLOT_SUBS 1
/* A song's tracks — one a channel, 16 at most — and as many sound-effect
 * parts again (def-se, driver.md §2.5). live/src/mmb.js MAX_TRACKS. */
#define MML_MAX_TRACKS 32
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
/* Every channel holds a velocity in eighths of a step (driver.md §7.1); the vel
 * tables are indexed by it. ir-utils.js VEL_FINE — tables.c sizes its arrays
 * from this, so a mismatch fails to compile. */
#define MML_VEL_FINE 8
#define MML_VEL_MAX (15 * MML_VEL_FINE)
extern const int16_t MML_VEL_TL4[MML_VEL_MAX + 1];
extern const int16_t MML_VOL_TL4[32];
extern const int16_t MML_VEL_PSG4[MML_VEL_MAX + 1];
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
   * live one a macro drives. note_on copies base -> live. Both in eighths
   * of a step (0..MML_VEL_MAX), on every channel kind. vol likewise
   * (§7.2): vol_base is the score's fader, vol the level a :vol macro moves;
   * note_on puts the fader back, and key-on mutes on the fader. */
  uint8_t vel_base, vel, vol_base, vol, gate;
  uint8_t current_note;
  int16_t pitch_cents;
  uint8_t keyed;
} MMLFmCh;

typedef struct {
  uint8_t vel_base, vel, vol_base, vol, gate;
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
/* The channels the macro engine runs on: 0-9, FM3's four operators and the
 * three PCM voices (macro_ch()). */
#define MML_MACRO_CHANNELS 17

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

/* TAIL: a PSG :vel release has played out; its next step silences the
 * channel (the release was the note's decay, so key-off left the level). */
enum { MML_MACRO_RUN = 0, MML_MACRO_HOLD = 1, MML_MACRO_RELEASE = 2, MML_MACRO_TAIL = 3 };

typedef struct {
  uint8_t macro_id;
  uint8_t state; /* MML_MACRO_RUN / _HOLD / _RELEASE */
  uint8_t dead;  /* finished this frame; compacted after the pass */
  uint8_t fresh; /* the note's own frame: a KEYON step here does not re-attack */
  uint16_t cursor;
  int16_t step_clock; /* frames left on this step; signed, a step of 0 free-runs */
  uint16_t acc;       /* tick clock (flags bit3): the note's track accumulator, 8.8 */
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
  uint8_t keyed;      /* a note is on, up to its note-off: a macro's release waits for it */
  uint8_t retrig;     /* a :keyon step restarts the blob once the frame's levels are in */
  uint8_t sample_id;  /* the running note's sample: what an SE-end restarts */
  uint8_t muted;
  uint16_t src;       /* the note's blob, as a window address */
  uint16_t len;       /* …and its length in bytes (whole blocks) */
  uint8_t vel_base, vel, vol_base, vol; /* vel in eighths of a step, as FM and PSG */
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

/* ── SE (driver.md §2.5) ───────────────────────────────────────────────────
 * A channel's live state at the moment an SE steals it. FM: the PATCH as the
 * channel's register shadow holds it — a VOICE_TABLE-shaped entry plus $B4 —
 * so whatever set it (a voice, a partial def-fm, a mid-song :tl or :pan) comes
 * back; and note/vel/vol/gate/pitch. PSG: note + level + pitch (the period and
 * attenuation are re-derived), and on noise its mode. Restore re-keys the note that was sounding.
 * Mirrors drv-player _snapshotChannel / _restoreChannel. */
enum { MML_SNAP_NONE = 0, MML_SNAP_FM = 1, MML_SNAP_PSG = 2 };
typedef struct {
  uint8_t kind;
  uint8_t patch[29];          /* FM only: the voice entry the shadow encodes */
  uint8_t ams, fms; int8_t pan; /* FM only: $B4 */
  uint8_t noise_mode;           /* noise only: the one mode register */
  uint8_t note, vel_base, vel, vol_base, vol, gate;
  int16_t pitch_cents;
  /* The channel's MACRO BINDS, because claiming it wipes them (§2.2) and the
   * displaced part wants them back. A sweep in flight is not kept: it is a
   * gesture with a position, and the note it shaped re-attacks (§2.5). */
  MMLMacroBind macros[MML_MACRO_BINDS];
  uint8_t macro_count;
} MMLChanSnap;

/* CH3 TAKEN WHOLE (driver.md §2.5). CH3's operator mode and CSM are chip-wide
 * settings ($27, Timer A), not one channel's, so an effect with a part on
 * fm3, fm3-1…fm3-4, fm3-csm or fm3-csm-rate takes all of CH3 — every song part
 * on it is suspended — and this is what its end puts back: the mode, the
 * Timer A period, the shared channel's snapshot, and the four operators'
 * notes, levels, key bits and macro binds. One hold at a time: an effect that
 * preempts the holder inherits it. */
typedef struct {
  uint8_t active;       /* an effect holds CH3 */
  uint8_t se, prio;     /* which effect (its SE_TABLE number), at what priority */
  uint8_t mode;         /* $27 bits 7-6 as the song had them */
  uint16_t timer_a;     /* the song's Timer A period */
  uint8_t fm_keyed;     /* the shared channel was keyed (normal mode) */
  uint8_t op_mask;      /* the operators' key bits (operator mode) */
  MMLChanSnap ch;       /* the shared channel, and channel 2's binds */
  uint8_t op_note[4], op_vel_base[4], op_vel[4], op_vol_base[4], op_vol[4];
  int16_t op_cents[4];
  MMLMacroBind op_binds[4][MML_MACRO_BINDS];
  uint8_t op_bind_count[4];
} MMLCh3Snap;

typedef struct {
  uint8_t running, armed, held;
  /* SUSPENDED (the fourth track state, beside idle/running/held): a BGM owner
   * an SE displaced. It keeps its state, does not dispatch and does not own
   * its channel; the SE's end puts it back. Eviction would be the wrong
   * primitive — it stops the owner, and the BGM could never resume. */
  uint8_t suspended;
  MMLChanSnap snap; /* the channel as it was when this track was suspended */
  /* An SE track: what it stole, so its end can give it back. `displaced` is
   * the suspended owner's track INDEX (0xFF = none); a preempting SE inherits
   * it from the SE it replaces, so only the LAST SE restores the BGM. */
  uint8_t is_se, se_prio;
  uint8_t se_index; /* the effect this part plays for (SE_TABLE number), 0xFF = none */
  uint8_t displaced;
  /* A PCM SE: soft-mix voices have no owner track, so what is kept is the
   * looping BGM note the SE's PCM_NOTE_ON overwrote, restarted at SE-end, and
   * the voice's macro binds, which the SE's claim wiped and its end puts back.
   * pcm_se marks an SE that took voice pcm_vi at all. */
  uint8_t pcm_snap, pcm_snap_sample, pcm_snap_loop, pcm_vi;
  uint8_t pcm_se, pcm_bind_count;
  MMLMacroBind pcm_binds[MML_MACRO_BINDS];
  /* The frame the armed setup ran in. The armed frame advances no ticks at ALL
   * of its sub-ticks, not only the one that ran the setup (driver.md §3.5). */
  uint32_t armed_frame;
  uint8_t track_id, channel_id, flags;
  uint16_t event_offset; /* stream start, for a restart */
  uint16_t pc;
  uint16_t acc;      /* 8.8 tick accumulator */
  uint16_t inc;      /* an effect part's own tempo increment (the song's is s->increment) */
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
  const uint8_t *se_table;    /* SE_TABLE entries {prio, first track, parts} (mmb.md §16) */
  uint8_t se_count;
  /* SAMPLE_BANK (mmb.md §10) — a separate ROM bank, not an MMB section. Only
   * the entry table is the sequencer's business; the blob belongs to the Z80. */
  const uint8_t *sample_entries;
  uint16_t sample_count;
  uint32_t sample_blob_base;
  /* The score's PCM voice count (MMB header flags bits 2-3): which engine image
   * plays it, and so the rate stamp its bank must carry. */
  uint8_t pcm_voices;
  uint8_t frame_hz; /* 60 or 50 — the clock the score's numbers were baked for */
  /* Where the bank sits in the 68k ADDRESS SPACE. The Z80 reaches samples
   * through its 32 KB window, so PCM_START must carry an absolute {bank,
   * offset} — and only the host knows where rescomp put the blob. The gate
   * passes 0, which is what drv-player's _sampleBankBase models. */
  uint32_t sample_rom_base;
  uint16_t increment; /* 8.8, per song (driver.md §3.2) */
  uint16_t frame_inc; /* this frame's share of it, for tick-clocked macros */
  uint16_t cur_acc;   /* the dispatching track's accumulator after its tick */
  uint16_t off_acc[MML_MACRO_CHANNELS]; /* cur_acc at each channel's last key-off */
  /* The effect part whose note triggered a channel's macros (track index + 1,
   * 0 = the song's): a tick-clocked macro counts that part's ticks. */
  uint8_t mc_se[MML_MACRO_CHANNELS];

  MMLTrack trk[MML_MAX_TRACKS];
  uint8_t track_count;
  /* track id → index into trk, 0xff = no such track. A game polls
   * MMLisp_trig / MMLisp_trackActive per track per frame; a scan of the
   * tracks each time was 3% of the 68000 on a 9-track song. */
  uint8_t track_index[256];

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
  uint16_t timer_a;    /* the Timer A period last written (the CSM rate) */
  MMLCh3Snap ch3;      /* CH3 as an effect found it, while one holds it */

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
  uint8_t fm3_op_vel[4], fm3_op_vel_base[4], fm3_op_vol[4], fm3_op_vol_base[4];
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

/* A def-se by its number — its place in the score's SE_TABLE, the same in
 * every song of a bundle (mmb.md §16) — at the effect's own priority or
 * `priority` when it is not MML_SE_PRIO_DEFAULT (driver.md §2.5). On each part's
 * channel the current owner is SUSPENDED and its live state snapshotted, not
 * evicted; the part's END_OF_TRACK or mml_stop_se restores the owner
 * mid-note. Against an effect already on the channel, the priority decides:
 * lower is dropped (the playing one is untouched), equal or higher preempts
 * it and inherits its restore duty. A PCM part overwrites the voice instead;
 * a looping song note there is restarted at the effect's end.
 * Stop ends every part; playing is whether any part still runs. */
#define MML_SE_PRIO_DEFAULT (-1)
void mml_play_se(MMLSeq *s, uint8_t se, int priority);
void mml_stop_se(MMLSeq *s, uint8_t se);
int mml_se_playing(const MMLSeq *s, uint8_t se);
uint8_t mml_se_count(const MMLSeq *s);
/* Start the song: every track that is not an effect's part. */
void mml_start_song(MMLSeq *s);

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

/* Writes still queued behind the cap. */
uint16_t mml_pending(const MMLSeq *s);

/* The loaded score's tracks. The MMB knows how many there are and what their
 * ids are, so nothing downstream should be hardcoding either: a count that
 * stops short of the list silently never starts the tail of it, and PCM tracks
 * tend to sit at the end. */
uint8_t mml_track_count(const MMLSeq *s);
uint8_t mml_track_id(const MMLSeq *s, uint8_t index);
/* The track with this id, or NULL — one table read. */
const MMLTrack *mml_track_by_id(const MMLSeq *s, uint8_t track_id);

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
