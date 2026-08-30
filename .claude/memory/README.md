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

- [plan-68k-split.md](plan-68k-split.md) — **architecture pivot (2026-08-02):
  68k runs the sequencer, the Z80 becomes a PCM + chip-write engine.** The
  measurement that forced it, the 11 decisions taken, and the port state
  (P0 mixer prototype → P1 interface → P2 sequencer → P3 bring-up). **Read this
  first before touching the driver.** The design itself now lives in
  `docs/driver.md`; this file is the decision record and the running state.
  **Its LAST section is a HANDOFF (2026-08-29) — read that first.** The DAC work
  on branch `drv/dac-rate-probe` is unfinished and the user's verdict on it is
  "it has never once been good": the machine reports 100% music with 0 lost
  frames and it still sounds unstable, because what wobbles is the SAMPLE CLOCK
  and not the frame budget. Three hardware bugs there were invisible to every
  gate, and one fitted model constant was falsified by the machine. **The model
  cannot predict this machine — fix that before changing the engine again.**
- [plan-subtick-timing.md](plan-subtick-timing.md) — **sub-frame note timing:
  step 1 LANDED 2026-08-05** (`SLOT_SUBS = 3`, all three ports, gates green;
  the design is now `docs/driver.md` §3.5). Note onsets ride the mixer's three
  voice-pass boundaries, which already sit at 1/3 and 2/3 of a paced frame — no
  new Z80 structure, no extra chip writes. Kept for the measurement behind the
  dispatch/engines split, the four implementation deviations (PCM not
  subdivided, `pcm_frame` last, the `$2A` re-latch, the RAM map move), and
  steps 2-3, which macro/sweep subdivision waits on in [[plan-68k-split]].
- [z80-driver-status.md](z80-driver-status.md) — MMLispDRV living status: the
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
- [plan-68k-split.md](plan-68k-split.md) — the 68k-sequencer/Z80-PCM-engine
  split: the decision record, the port's running state, and every hardware and
  emulator round since. **Read its HANDOFF section (top of file) before
  touching the driver.** Currently: the measurement loop is closed (BlastEm as
  a libretro core + a probe ROM, all in-container, no listening round), and the
  DAC's 32% sample deficit is FIXED — the pacing pad was 41% of the interrupt,
  which pushed it past its vblank and made the mixer run every other frame.
  Next: a hardware round, and `drv-player.js` on the ring-fill model.
- [design-eval.md](design-eval.md) — v0.6 Phase 3 normative design: the
  compile-time eval spec (dispatch, value model, curves-as-library, `:seed`,
  operator desugaring, `let`), the value machine (sampling tiers, generic
  shadow read, left-fold lowering, slot allocation), CALL/RET + dedup, the
  measured Z80 budget + reduction ladder, and the ordered implementation
  plan with per-step gates. The design rationale record (language.md carries
  the shipped spec).
