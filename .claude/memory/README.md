# Project memory (cross-session, in-repo)

Session-persistent project state that any Claude session — local or cloud —
needs to continue multi-session work. Unlike `~/.claude` local memory, these
files are checked in and travel with the repo.

Rules:

- One topic per file; keep each file current (edit in place, delete when the
  work lands and the repo itself records the outcome).
- This is for *state and plans that code/docs don't yet record* — not for
  documentation (that goes in `docs/`) or personal workflow preferences.

Index:

- [plan-subtick-timing.md](plan-subtick-timing.md) — **RETIRED 2026-09-14 (SLOT_SUBS = 1, onsets on the frame; user's call). Was: sub-frame note timing:
  step 1 LANDED 2026-08-05** (`SLOT_SUBS = 3`, all three ports, gates green;
  the design is now `docs/driver.md` §3.5). Note onsets ride the mixer's three
  voice-pass boundaries, which already sit at 1/3 and 2/3 of a paced frame — no
  new Z80 structure, no extra chip writes. Kept for the measurement behind the
  dispatch/engines split, the four implementation deviations (PCM not
  subdivided, `pcm_frame` last, the `$2A` re-latch, the RAM map move), and
  steps 2-3, which macro/sweep subdivision waits on in [[plan-68k-split]].
- [z80-driver-status.md](z80-driver-status.md) — **the all-Z80 build's record; that build was
  removed 2026-09-15 (tag `archive/all-z80`).** Was: MMLispDRV living status: the
  Done list (M1–M3, v0.6 value machine, VOICE_SET, CALL/RET, SE, PCM volume,
  trig), the remaining-work list (hardware bring-up, PAL, open ir↔drv
  divergences), the byte/stack budget, and how to verify. **Now largely the
  record of the all-Z80 build** — its feature semantics all survive in
  `drv-player.js` (the port spec), but its byte/cycle budgets describe an
  architecture [[plan-68k-split]] replaced.
- [plan-se.md](plan-se.md) — SE (sound effects): **core LANDED** (sample-bank
  separation, FM/PSG/PCM suspend-restore, priority, PCM per-channel volume).
  Kept for the remaining work — the BGM+SE bundler/link tool (not started),
  the N=1→pool, stop_track reclaim, and the worklet/hardware follow-ups. The
  SE implementation record.
- [plan-driver-features.md](plan-driver-features.md) — post-M3 driver feature
  roadmap (budget-meeting outcome): the two-budget frame (resident bytes vs
  per-frame cycles) + the overlay-split enabler. **Most items landed**
  (CALL/RET, SE, PCM volume, trig, sample-bank); remaining = DJ cross-MMB
  transitions (hardware-gated), WIDE_OFFSETS, the CALL/RET shared-loop-body
  extension. Also holds the folded-in DAC-ownership decision (static `:prio`).
- [plan-editor-input-aids.md](plan-editor-input-aids.md) — live editor Lisp
  input aids: **batch 1 landed** (auto-close, enclosing-form highlight,
  unmatched-bracket marks + badge) with the implementation deviations worth
  keeping; still open are snippet completions, expand-selection, a touch
  symbol bar. Also holds the standing "never auto-repair brackets" decision.
- [plan-68k-split.md](plan-68k-split.md) — the 68k-sequencer / Z80-engine
  split (2026-08-02): the measurement that forced it, the decisions, and every
  port, hardware and emulator round since. The design itself is
  `docs/driver.md`; this is the decision record. Its handoffs are history — the
  engine they describe was replaced by D10 ([[plan-pcm-spec]]).
- [plan-pcm-spec.md](plan-pcm-spec.md) — **PCM: the user's decisions behind
  the shipped light engine (D10, landed 2026-09-18) with their reasons, and
  what is still open** (hardware run, two loop semantics to decide, PCM SE in
  the C, the D7 sample keys). Read before touching
  PCM in any layer.
- [plan-dac-stream.md](plan-dac-stream.md) — **the DAC engine redesign
  (`docs/dac-engine-implementation.md`). R28 (2026-09-11): SHIPPED — the
  one-voice pair-transport engine is the production image; a mucom88 song plays
  in a real SGDK build on BlastEm with every write and DAC byte graded. Read its
  head and its last section ("Step 4/5") first.** Earlier: P0, P1 and most of
  P2 DONE 2026-09-06. The
  baseline tool and what it found (`npm run engine` has been red for ~40
  commits and `verify:all`'s `&&` was hiding four gates behind it), the
  output-centred prototype (the bench, removed 2026-09-18, is at tag
  `archive/dac-stream-bench`) (9,987.57 Hz at
  +0.0000%, zero holes, two voices with independent levels and a master, in the
  JS model only), the structural decisions — the slot boundary is the `$2A`
  write, there is no interrupt, the pad is solved, production is locked to
  consumption so the ring needs no regulator, and every slot's work must be
  constant time — and **three bugs it found in the shared toolchain, one of which
  under-charged every cycle budget in the repository by 3 cycles per `(HL)`
  access.** The engine it produced was replaced by D10; kept as the record.
- [design-eval.md](design-eval.md) — v0.6 Phase 3 normative design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. The design rationale record (language.md carries
  the shipped spec).
