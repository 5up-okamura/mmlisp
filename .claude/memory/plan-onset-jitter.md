# Onset jitter under write bursts — the decisions (2026-10-07)

What the user hears as tempo wobble: a frame whose pairs exceed the Z80's
service (NTSC pairs/s — single-bank 1,027 / 1,011 / 1,109 for one, two,
three voices; banked 6,952 / 1,896 / 1,663) slides every key-on behind the
pairs queued before it. A 29-write voice change is ~1 frame at banked two
voices, three channels at once ~3 frames. The behaviour that landed is in
`docs/language.md` §9 and `docs/driver.md` §3.5; this file keeps why, the
measurements, and what is still open.

## Status (2026-10-07)

- **Built: the voice hoist** (`live/src/voice-hoist.js`, compiler pass;
  gate `tools/voice-hoist-gate.mjs`, fixture `tests/m4-voice-hoist.mmlisp`).
  Windows are ticks of the 50 Hz frame (rest: 4 frames, note cut: 2), the same
  on both standards — sized per standard, pal-gate's strict write order broke.
  A voice in the same tick as its tail cut folds into one VOICE_SET, so the cut
  goes a frame ahead (`cutTail`, off by default).
- **The user's test score is sin008** (`~/Desktop/mucom/sin008.mmlisp`, a
  mucom import — never in the repo), single-bank pcm1. The wobble near 14 s is
  the 15.02 s downbeat: fm4/fm5 switch to `@orc004` (65 writes in one frame),
  and 13.13 s, their entry after `(x 7 _1)`. Measured with
  `tools/onset-timing.mjs` (JS machine) and on BlastEm (scratch script, the
  example project with `res/song.mmb` swapped per variant):

  | BlastEm, 2–30 s | late p95 | max | 15.02 s beat (fm1/fm5/fm4/fm2) |
  | --- | ---: | ---: | --- |
  | before | 18.0 ms | 91.1 ms | 16 / 50 / 88 / 91 |
  | hoist | 17.1 ms | 31.9 ms | 0 / 12 / 19 / 22 |
  | hoist + tail cut | 17.1 ms | 31.7 ms | 0 / 12 / 19 / 22 |

  WAVs for listening: `~/Desktop/mucom/onset-listen/sin008-{A-now,B-hoist,C-hoist-cut}.wav`.
- **Tail cut: no audible difference on sin008** (user, 2026-10-07) — its
  voice changes follow no long-RR note. Default stays off (fewer writes);
  revisit only on a score with a long release before a voice change.
- **Key-ons last: adopted** (user listened to D, 2026-10-07: no problem).
- **Verified by the user on the live app and on BlastEm** (2026-10-07): the
  voice hoist and key-ons last together, sin008.
  Unconditional in the single-bank converter, C and JS; no flag. Not applied
  to `banked_writes`: its short-groups-first rule would be undone by it, and
  that combination has had no listening — open.
- **Pre-existing, not ours:** `sgdk:gate` (not in verify:all) fails at FM
  port 0 write 0 (`$2B` vs `$B0`) on an unmodified checkout too — it does not
  expect the PCM lane's `$2B` ahead of the FM queue.
- **Key-ons last, measured** — `mmlpairs.c` keyons_last and its JS twin
  `PairsModel.keyOnsLast`; gates expect it through `recordWritesOnWire`, and
  pairs-gate's KEY ORDER check matches writes by value. BlastEm, sin008
  with the hoist: chord spread p95 19.5 → 3.0 ms, max 33 → 4; late p95
  17.1 → 16.4, max 31.9 → 29.3; per-channel interval error p95 15.9 → 20.2,
  max 32.0 → 30.9. WAV `sin008-D-hoist-keyons-last.wav`. JS-machine numbers: On sin008: chord spread p95 18.5 → 3.0 ms,
  but the beat comes slightly later (late p95 19.1 → 21.8, per-channel interval
  error p95 11.1 → 13.8). A character choice — not ported to C until the user
  hears it. What remains after the hoist is exactly these chord frames (5
  key-ons + PCM, 14–18 writes, over the 16-pair frame).
- **Declined after measuring: skipping unchanged pitch pairs.** Half of
  sin008's pitch pairs rewrite the same value, but only 12 writes fall in heavy
  frames over 30 s — not worth changing drv-player, the C sequencer and the A/B
  baselines.

## Decided

- **No transport increase.** Raising the single-bank images' expander steps
  helps `pcm1` only (two/three voices gain ~20%, the banked images do not
  place at more steps) and reopens the images' hardware risk. Capacity is
  closed; the work is "fewer pairs ahead of a key-on".
- **FM voice changes move to the previous note's gate-off (b).** Rests are
  rare in MML (lengths, not rests, set timing), but the legato guard keys the
  previous note off one frame before the next key-on — that frame is the
  window. The compiler moves the VOICE event from the note's tick to the
  previous note's gate-off tick on the same track, so the patch drains in
  frame f and the key-on frame carries pitch + key-on + TL diffs. Compiler
  level, so the IR preview and the driver play the same stream and the A/B
  gates stay meaningful. Slurs and ties have no key-off and get nothing,
  which costs nothing. Loops and `call` bodies take the shortest window
  across entries or skip.
- **The tail is cut, by rule.** A patch written during a release changes the
  tail (MUL/DT shift its pitch, TL steps its level). So a voice change applied
  while the channel is keyed off first writes RR=15 on the old patch's
  carriers (1–4 writes), then the patch. The user accepts this change of
  sound — and accepts the previous note ending up to **two frames** early if
  one frame is not enough — over tempo wobble, **subject to listening**:
  render current / hoist only / hoist + fast release / two-frame window to
  WAV through Nuked and compare by ear and by difference. A song-level
  setting widens the window (name to be decided from existing words — `gate`
  is the vocabulary); per-note marks are not wanted.
- **PCM STAGE, without touching the MMB (c).** No file opcode: the sequencer
  peeks the same track's next PCM note (stopping at loop/call boundaries)
  and emits a STAGE frame command (SRC/END/WRAP/bank, no generation) once the
  previous START has been applied; the note's START keeps carrying every
  value and the converter's diff makes it one pair when the staged bytes
  match. STAGE is a prepayment that is never required for correctness; a
  `:keyon` retrigger or an SE restore re-staging over it only costs that note
  its old price. The ir-player preview mirrors it, or `pcm-ab` compares
  STARTs only.
- **Key-ons last in the frame.** The converter keeps each channel's own
  order and moves only key-on writes (`$28` with key bits) to the frame's
  end, so a chord's key-ons sit within a few pairs (~3 ms) instead of behind
  every pitch and TL of the frame (~10 ms for six channels). Key-offs stay;
  frames with a global write other than `$22`/`$24–$26` are left as they
  are; CH3 in special/CSM mode is not moved. Applies to the single-bank
  converter too — JS twin and `pairs-gate` follow.
- **Ordinary FM3 joins the short-group priority** when the converter's own
  `$27` shadow says normal mode and the frame has no `$27` write.
- **Measure first, on the user's songs.** From the drv-player slot log,
  pairs per frame by class (patch / pitch / TL / pan / macro traffic / PCM
  stores / fences) on the frames that wobble, so the order of the work
  follows what the bursts are made of. The key-on interval error (p95 / max)
  that `banked:sgdk` reports becomes the metric for the single-bank path too,
  on a fixture where several channels change voice on one beat; target under
  a frame, ideally a quarter.

Order as decided: measure → key-ons last → STAGE → FM3 → voice change. The
measurement put the voice change first for sin008 (it is single-bank, one PCM
voice: STAGE and FM3 do not touch its late beats); STAGE and the FM3 rule are
still open for the PCM-heavy and banked cases.

## Rejected

- 68000 writing patches directly under BUSREQ: the engine keeps the port-0
  address latch at `$2A` and the expander's address/data writes are not
  atomic against a bus stop; guarding it costs the hot path.
- A frame mark in the FIFO so the Z80 commits key-ons on the frame edge:
  makes lateness uniform, does not create service.
- Writing the new patch right after the key-on: the attack is the most
  audible part of the note.
