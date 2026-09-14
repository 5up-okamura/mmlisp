# PCM/DAC language spec — settling it against the shipped engine (2026-09-14)

The four PCM paths disagree: the browser (ir-player + live/worklet.js, closest
to the docs), the JS reference driver + C sequencer (2 voices, loops keyed on
the sample, 6 dB shift model), the shipped pair-transport engine (1 voice, no
loops, 15 linear levels) and the docs (3 soft-mixed voices, the ring engine's
model). The user wants ONE spec before SE. Audit done 2026-09-14 (file:line
evidence was in that session; re-derive from the code, it is quick).

## Bugs found, independent of the spec (not fixed yet)

1. fm6 FM is silent on hardware in EVERY song: the engine boots with
   `$2B=$80` (gen-stream.mjs boot) and `q_push` drops every `$2A/$2B`
   (mmlispseq.c). Docs promise fm6 in the gaps.
2. C out-of-bounds: `PARAM_SET VEL/VOL` on pcm3 writes `s->pcm[2]` with
   `MML_PCM_VOICES 2` (mmlispseq.c param path; the JS has a guard). The
   exporter emits a VEL at every loop head, so any looping pcm3 track hits it.
3. The bank is baked for 60 × 166.674 = 10,000.45 Hz (`PCM_BAKE_RATE_REF`,
   mmb.js) but the engine plays 9,987.57 Hz: PCM ~2.2 cents flat vs FM.

## Decisions (user, 2026-09-14)

* D2 rate: 9,987.57 Hz fixed, stated in the spec; bake for it (fixes bug 3).
* D3 loops: shot-only for now (plays to its end or is cut by the next note on
  the voice; `:mode loop` / loop points become errors). The user WANTS loops
  back once there is a way — engine loop wrap is boundary work, design later.
* D4 levels: map `:vel`/`:vol`/`:master` in dB (FM's ladder) to the nearest of
  the engine's 15 linear levels (k/14; 1/14 = −22.9 dB), silence below — uses
  all 15 instead of today's 5 rungs, and master ≤ 17 stops silencing PCM.
  Host table only. The 15 levels cost NO CPU (one LUT read regardless of
  count) but 3,840 B of Z80 RAM (15 pages at $0C00) — the lever if a second
  voice needs RAM; the user accepts fewer levels if something else needs it.
  Track-level PCM `:vol` curves: song fade via master works; per-track curves
  → error (proposed, not explicitly confirmed).
* D5 pitch: per-note bake is the spec; no C2–C6 clamp (the bank is the only
  limit); glide/vibrato/`:pitch`/macros on PCM → errors instead of silence.
  User asked about octave-by-shift: the engine ALREADY has a 2^k step
  (self-modified add, host rounds to 1/2/4/8, MMB flags bits4-7 exist); only
  the exporter always bakes k=0. Costs no Z80 cycles; saves bank ROM; costs
  aliasing (decimation, no low-pass) and ≤16·step samples of tail. Up only.
  Whether to expose it (explicit sample key vs never) is OPEN.
* D6 fm6/DAC: per song — a score with PCM owns fm6 as the DAC all song (fm6
  FM + pcm in one score = error); a score without PCM gets fm6 as FM. The
  "fm6 in the gaps" behaviour is dropped. Fixes bug 1.
* D7 `:bit-depth` `:volume` `:compress` `:reverb`: never implemented anywhere;
  the user wants ALL of them later (small per-sample adjustments). Until then:
  warn "not implemented" instead of silently ignoring (proposed).

## OPEN

* D1 voice count — the user did not expect 1 voice and finds it inferior to
  other drivers; wants it studied. Why 1 today (R28 §63.2): a 2-voice mixer is
  207 cyc/slot vs ~135 (+70 × 80 = 5,600/lap) on a 358-cycle slot already at
  worst 83.8%, plus a 512 B clamp table and IX/IY/AF'/HL' the expander now
  uses. Options: (A) 2 voices at a lower rate (search the highest rate the
  generator places), (B) free RAM by fewer level pages, (C) compile-time
  premix of pcm1..3 overlaps into composite blobs (engine unchanged; bank ROM;
  not for SE/runtime-variable parts), or a mix.
* D0 "the browser sounds like the hardware" (worklet emulates 9,987.57 Hz,
  8-bit, the engine's voice count and level table) — proposed, not answered.

## Cleanup (proposed, not started) — inventory 2026-09-14

Move the shipped generator out of `drv/experimental/dac-stream/` (14 modules +
phase-table.json) to `drv/engine/`, current gates (gate-1v/fifo/score,
machine.mjs, probe-analysis, cooperative) to tools; tag then delete the ring
engine (its gates are red) and possibly the all-Z80 build (the tiny Z80-only
version could start from the tag); delete orphans (root tools/gen-mixer.mjs 0 B,
drv/tools/emit2.z80, wip-block-mixer.patch, broken verify-rom jig); rate-mirrors
still reads the ring's src/*.z80; drv/out is 6.5 GB (only out/blastem needed);
driver.md ~half and drv/README.md describe superseded engines; MMB LUT_TABLE has
no consumer (format decision). Order: decide spec → cleanup (no behaviour
change) → implement spec across browser/exporter/C/JS/docs, in separate chats.
