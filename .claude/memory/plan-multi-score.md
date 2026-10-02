# Several scores — what is built, and what a second resident score would take

**The shared bank is built (2026-09-23): `drv/tools/bundle.mjs`**
(`driver.md` §2.3, `mmb.md` §10.2, the SGDK README). **Two scores resident at
once is not built** — `driver.md` §2.3 says why (the per-score state lives on
the sequencer) and that a track is a channel. This file keeps what moving that
state would cost, and the bundle's decisions.

## What it would take

Move the per-score state off the sequencer (`MMLSeq`'s stream, `voices`,
`macro_table`, `sample_entries`, `sample_blob_base`, `increment`, `frame_hz`,
`pcm_voices`; `drv-player.js` likewise) — better into a small score struct the
track points at than onto each track, so N tracks of a score share one copy.
The ones with teeth:

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

## Decisions inside the bundle (shipped)

`driver.md` §2.3 has what the bundle does; these are the choices behind it.

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
32 KB bank — so every song carrying the game's effects costs little: the
bundle's `"se"` compiles one `def-se` file into every song (plan-se.md).

## Why it was wanted

Two things, which may not need the same mechanism:

1. **BGM + SE as separate files.** Answered by the bundle: one bank, and one
   `def-se` file every song is compiled with.
2. **DJ-style transitions between songs** — one phrase retained, the next song
   at the same tempo, fade in. Within one MMB each side may use at most half
   the machine (`driver.md` §2.3); cross-*file* transitions need the data model
   moved.

So what remains is the cross-file transition, and it costs the data-model
move above. The shared bank across songs is shipped.
