# Several scores resident at once — the starting point

**Nothing is built.** `roadmap.md` Phase 3 open #4, `driver.md` §11. This file
exists so the work does not start from a false premise, because the docs used
to carry one.

## The false premise, corrected 2026-09-22

`driver.md` §2.3 used to say "a track control block carries the pointer to its
own score, so the sequencer's model allows tracks of several MMBs to run at
once." **It does not.** Checked in both implementations:

- `MMLTrack` (`68k/mmlispseq.h`) holds `event_offset` and `pc` — *offsets*, not
  pointers — into `MMLSeq.stream`, of which there is exactly one.
- `MMLSeq` also owns `voices` / `voice_count`, `macro_table` / `macro_count`,
  `sample_entries`, `sample_blob_base`, `increment`, `frame_hz` and
  `pcm_voices`. Every one of those is a property of a *score*, sitting on the
  sequencer.
- `drv-player.js` matches: `_macros`, `_voices`, `_increment` are the player's,
  not the track's.

So "the host only loads one at a time" was never the constraint. The
constraint is the data model. §2.3 and §3.2 now say so.

## What it would take

Move the per-score state off the sequencer — either onto the track or, better,
into a small score struct the track points at, so N tracks of the same score
share one copy. The list is above; the ones with teeth:

- **The tempo increment is per score** (`driver.md` §3.2), so concurrent scores
  need concurrent increments and a TEMPO_SET must reach only its own score's
  tracks. Today one `TEMPO_SET` on any track retimes everything.
- **The frame clock is per score too, now that PAL exists** (`frame_hz`,
  §3.3). Two scores baked for different standards must not be resident
  together — that is a load-time refusal, not a runtime mode.
- **Sample entries and the PCM voice count** pick the engine image. Two scores
  wanting different images cannot both be resident: the image is the Z80's
  program. This is a hard limit, not a porting cost, and it is the reason the
  SE work chose bundling instead (`plan-se.md` decision 2).
- The byte-for-byte gate (`c-gate`) compares slot streams; a second resident
  score needs a gate score with two MMBs and a host schedule that starts tracks
  from each. No harness does that yet — `buildMmb` returns one blob.

## Why it was wanted

Two things, which may not need the same mechanism:

1. **BGM + SE as separate files.** Already answered for now by bundling at
   build time; see `plan-se.md`.
2. **DJ-style transitions between songs** — one phrase retained, the next song
   at the same tempo, fade in. Within one MMB this **already works** (two
   sections in one score, `MMLisp_fadeTrack` per track) and is documented in
   `driver.md` §2.3. It is only cross-*file* transitions that need this.

So before paying for it, decide which of the two is actually being asked for —
the in-score answer is free and shipped.
