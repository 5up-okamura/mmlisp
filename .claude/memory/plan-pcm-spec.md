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

* D2 rate: ONE fixed rate, stated in the spec, and the bank is baked for the
  engine's true rate (fixes bug 3). 9,987.57 Hz today; D1's two-voice study
  may lower it — the spec number waits for that verdict.
* D3 loops: shot-only for now (plays to its end or is cut by the next note on
  the voice; `:mode loop` / loop points become errors). The user WANTS loops
  back once there is a way — engine loop wrap is boundary work, design later.
* D4 levels — REVISED by the user (2026-09-14, second answer): back to the
  6 dB shift model (driver.md §14/§14.1, decided 2026-08-12: stepped by
  design, finer resolution out of scope). The shipped 15 linear LUT pages
  (3,840 B, nearly half the Z80's 8 KB) came from the designer log's own
  requirement (dac-engine-implementation.md line ~110 "at least 16 levels, do
  not narrow the fade to a bit shift", §24 the 15-level profile) and the
  implementer carried it into R28 WITHOUT flagging that it contradicted the
  user's decision — the user: "more memory than expected, I said bit shifts
  were enough; this is not what I intended". Implementation is free to pick
  the cheapest constant-time form (a few shift pages keep today's cycles at
  ~1/3 the RAM; composing master into each voice's shift on the 68k removes
  the master stage), chosen together with D1 because RAM and cycles trade.
  The freed RAM goes to the second voice.
* D5 pitch: per-note bake is the spec; no C2–C6 clamp (the bank is the only
  limit); glide/vibrato/`:pitch`/macros on PCM → errors instead of silence.
  User asked about octave-by-shift: the engine ALREADY has a 2^k step
  (self-modified add, host rounds to 1/2/4/8, MMB flags bits4-7 exist); only
  the exporter always bakes k=0. Costs no Z80 cycles; saves bank ROM; costs
  aliasing (decimation, no low-pass) and ≤16·step samples of tail. Up only.
  DECIDED: exposed as an explicit per-sample key (name TBD), never automatic.
* D6 fm6/DAC: per song — a score with PCM owns fm6 as the DAC all song (fm6
  FM + pcm in one score = error); a score without PCM gets fm6 as FM. The
  "fm6 in the gaps" behaviour is dropped. Fixes bug 1.
* D7 `:bit-depth` `:volume` `:compress` `:reverb`: never implemented anywhere;
  the user wants ALL of them later (small per-sample adjustments). Until then:
  warn "not implemented" instead of silently ignoring (proposed).

## Decided in the second round (2026-09-14)

* D0 DECIDED: the browser must sound like the driver ("otherwise this is not
  a production environment for this driver") — the worklet emulates the
  engine's rate, 8-bit output, voice count and level model.
* D1 DECIDED direction: multiple voices are wanted. First study (A) TWO
  voices at a LOWER rate — find the highest rate the generator places with 2
  voices + transport + corrector (estimate ~8 kHz: +70 cyc/slot on a slot at
  worst 83.8%), with D4's shift levels; then (C) compile-time premix of
  pcm1..3 overlaps on top, for more expression. The user wants the FINAL
  VERDICT reported (rate, voices, levels, RAM, cost) before the spec is
  implemented. Why 1 today (R28 §63.2): 2-voice mixer 207 cyc/slot vs ~135,
  512 B clamp table, IX/IY/AF'/HL' now used by the expander.

Order: (1) cleanup, no behaviour change; (2) D1+D4 study → verdict to the
user; (3) implement the spec in every layer + bugs 1-3 (bug 3's bake rate
waits for D1's rate); (4) premix; loops (D3) and D7 keys later.

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
