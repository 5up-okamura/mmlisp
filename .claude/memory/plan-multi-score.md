# Several scores — what is built, and what a second resident score would take

**The shared bank is built (2026-09-23): `drv/tools/bundle.mjs`.** N scores,
one `.smp`, one engine image for all, gated on the bundled artifacts
(`c-gate --bundle`), installed by `install-sgdk --bundle`; `driver.md` §2.3,
`mmb.md` §10.2, the SGDK README. **Two scores resident at once is still not
built**, and this file's second half is what that would take. Its first half
is the reasoning that led to the bank being the thing to share.

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

## The channel budget, measured 2026-09-22

**A score cannot hold several songs, and the reason is structural: a track IS a
channel.** Two blocks on one channel merge into one timeline
(`layersByHead` in `mmlisp2ir.js`), so a song's tracks are a partition of the
machine's channels, not a free list. A score using every channel there is
compiles to exactly **16** tracks — fm1-fm5, sqr1-3, noise, pcm1-3, fm3-1..4,
with fm6 gone to the DAC — which is why `MML_MAX_TRACKS` is 16. It is the chip,
not a chosen ceiling, and there is no room left over for a second song.

So §2.3's "a transition is started and faded per track" costs BOTH songs'
channels at once: a cross-fade inside one score is only possible when each side
uses at most half the machine. That is a real restriction on the in-score
answer below, which this file used to present as free.

## What is shared across songs: the sample bank (shipped)

`MMLisp_setSampleBank` remembers the pointer and `MMLisp_loadScore` re-applies
it, so one bank serves every song. What stopped that — per-score sample ids
from 0, and the bank's rate stamp binding it to one engine image — is what
`bundle.mjs` resolves: every score plans into one `createSampleBankBuilder`
(entries deduplicated by content), and every score is encoded for the
manifest's PCM voice count, so the stamp matches and a song change reboots
nothing. The voice count is taken AFTER the effect remap (an effect authored on
pcm2 and pointed at pcm1 needs one voice, not two), and a `(def pcm-voices N)`
in a bundled score is superseded by the manifest.

Decisions taken in the build, for whoever revisits them:
- Content dedup is ON only for bundles; a score built alone keeps its bank
  byte for byte.
- A non-PCM song in a bundle still boots the bundle's image — the reboot-free
  song change is worth more than the idle voice.
- The self-test compares every bundled entry a song plays against the entry its
  own bank would have carried; the gate then compares C against the reference
  on the bundled MMB + shared bank.
- `MMLisp_loadScore` still plays a score whose bank was refused; the reason is
  now `MMLispStats.bank` (-3 = baked for another image) instead of silence.

Control data is cheap — a demo song's MMB is under a kilobyte against the
32 KB bank — so repeating a set of effect tracks in every song costs little.
That repetition is the one thing left: **`import` brings in defs, not tracks**
(language.md §9.2, by design), so a game repeats its effect track lines per
song. Making tracks importable is a language decision, not a tooling one; it
is recorded in `plan-se.md`.

A song change resets the val slots: `mml_load` zeroes the sequencer and
re-seeds `VAL_TABLE`, so the game writes them again (the example does).

## Why it was wanted

Two things, which may not need the same mechanism:

1. **BGM + SE as separate files.** The samples: answered by the bundle. The
   tracks: every song's source carries its effect track lines, a few per
   effect, until tracks are importable.
2. **DJ-style transitions between songs** — one phrase retained, the next song
   at the same tempo, fade in. Within one MMB this works only within the
   channel budget above: both songs are resident on different channels, so each
   may use at most half the machine. Cross-*file* transitions need the data
   model moved.

So what remains is the cross-file transition, and it costs the data-model
move above. The shared bank across songs is shipped.
