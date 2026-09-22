# The language and IR: what is open, and why the value machine looks like this

Two things live here, because a session working on the language needs both:
**the open questions** (§1–§4, from the 2026-09-18 audit) and **the design
rationale behind compile-time eval and the value machine** (§5, merged from
`design-eval.md` 2026-09-22). `docs/language.md` carries the shipped spec; this
is only what the docs do not say.

`design-eval.md`'s Z80 byte budgets, its reduction ladder and every `.z80` line
reference described the all-Z80 build (tag `archive/all-z80`) and are gone; so
is its step-by-step implementation diary, which is git history. Its line
references were against a 2026-07 tree and none resolve.

## 1. Needs the user's decision (the driver sounds different from the editor)

1. **Glide longer than its note** (§14): slide faster to finish inside the
   note, or cut at the note end? Today both players let it run into later
   notes.
2. **`:vol* $slot`** (§8): preview multiplies by the slot as an integer,
   driver as 8.8 (`>> 8`) — which is the meaning?
3. **`:keyon` + `:off`** (§10): driver's retrigger restarts every macro from
   its attack (the doc's echo-tail vel replays 15); preview only re-keys $28;
   PSG `:keyon` works on the driver only. The exporter comment says restarting
   the soft envelopes is intended — which wins?
4. **CSM "rest the rate source to silence"** (§15): no CSM_OFF is emitted.
5. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
6. **`:hold`** (§11): unit undefined — it quantizes the LUT index, not steps.
7. **Note names vs defs** (§3): the doc says a def named like a note cannot be
   referenced; the code lets the def win. Error at def time?
8. **`(fm3 …)` notes beside fm3-N tracks**: no diagnostic.

## 2. Decided and fixed

- **fm3-N levels are per operator** (2026-09-22, user kept `(fm3 …) :vol`).
  `tl[op] = voiced_tl[op] + dB(op vel) + dB(op vol) + dB(CH3 vol) + dB(master)`
  — the shared track's `:vol` stays as a group fader and becomes one more term
  in the sum instead of being removed. The carrier table is NOT consulted: on a
  modulator the level is modulation depth, which the user accepted as a timbre
  knob (option A). `vol 0` attenuates to silence rather than muting the key.
  Registers were never the obstacle — every operator has its own TL — the
  obstacle was op1 sharing channel 2 with the patch track, which also turned
  out to be silencing op1 on that track's rests.

- **A `:tl` is a voiced level on every write path** (2026-09-22). Chased from
  the note above — a mid-song patch change on CH3 written as a FULL voice
  (`VOICE_SET`) losing the operators' levels. The cause was not special mode
  and not VOICE_SET: `T_FM_TL*` PARAM_SET wrote `$40` RAW in all three players,
  and `voice_set` composed against the CHANNEL's carrier mask, which in special
  mode is the wrong rule. So any mid-song `:tl` — on any channel — dropped
  vel/vol/master until the next note-on recomposed, and a sustaining note has
  no next note-on. Measured: `:vol 24` plays a TL-20 patch at 39; `:tl1 40`
  then wrote 40 instead of 59.

  Fixed with ONE helper per player (`op_level` / `_opLevel`) holding the
  channel's rule — carriers compose and modulators stay raw on a normal
  channel, all four compose in special mode — called from both the PARAM_SET
  and the VOICE_SET path. Gate `m4-tl-compose` covers the three cases in one
  score; `m3-loop-vel-hold` lost 4 A/B divergences (6 → 2), which were exactly
  the carrier-TL writes the editor emitted and the driver did not.

  Note for future audits: ab-gate could NOT have caught this — both players
  were raw, so they agreed. Only reading the register trace against §7 did.

- **Abutting fm3-N notes re-attack** (2026-09-21/22). The driver always did;
  the EDITOR's key merge left no gap — a full-gate operator note's interval
  ended exactly where the next one began, `_fm3MaskAt` returned the same mask
  on both sides, and no `$28` write happened at all, so every consecutive pair
  of operator notes was silently a slur. Against §17's re-key rule, and the
  driver was right. Fixed by closing the previous interval for that operator
  `KEY_ORDER_EPS_SECS` before the new key-on — the same ordering margin the
  normal channels' deferred key-off uses, where the separation the chip needs
  comes from the write path's own cost, not from the margin. `m3-fm3op` and
  `m4-fm3op-pitch` each lost one A/B divergence; their baselines are the gate.

- **A `:keyon` macro's leading step is a no-op** (2026-09-21, user: "先頭の
  アタック意味ないでしょ"). The first sample lands in the note's own frame,
  where the note has just attacked, so re-attacking there is a write with
  nothing behind it. language.md §10 had said this all along ("The first
  sample at t = 0 … is a no-op") and ir-player did it; the DRIVER was the one
  diverging, on every channel. Fixed in `mmlispseq.c` and `drv-player.js` with
  a per-slot `fresh` flag (the sustain loop can return to cursor 0, so the
  cursor alone cannot say "first"). Gate: `m3-macro-keyon`'s fm4 track,
  `[1 1 1 1]` — 0-diff on `$28` between the two players.

## 3. Decided, no change

- **Consecutive `:gate 0` notes do not re-attack** (2026-09-20, user). Every
  other FM note now does — a full-gate note keys off right before the next
  note-on, and only `~` suppresses it — but `:gate 0` is an explicit request to
  hold, and the hold's key-off belongs to the runtime (`triggerKeyOff` / host
  `KEY_OFF`), which is the whole point of the form. Measured: `:gate 0 c e g`
  writes `f0 f0 f0` and sounds one attack with the pitch moving — the same
  object as `c ~ e ~ g`, so it reads as a sticky legato passage. FM only: PSG
  re-asserts its attenuation on every note-on and re-attacks either way.
  Written into language.md §17.

## 4. Judgment-free but larger

- ~~fm3-N glide / pitch macros do nothing (or hit CH3) on the driver~~ FIXED
  2026-09-21/22 (`m4-fm3op-pitch`, `m4-fm3op-keyon`, `m4-fm3op-level`,
  `m4-fm3-voice-track`): pitch, `:keyon` AND level are per operator in all
  three players. The enabler was giving op1 its own channel id — operators are
  16-19 now, channel 2 is the shared CH3 alone.
- def-val min/max on the driver: VAL_TABLE carries no range, so SGDK setVal
  clamps only to i16 (§8) — a format change.
- Nf in one track converted at another track's mid-song tempo change (§4).
- Tick-0 tempo written as an expression is not seen by the Nf prescan.
- Imports: a local def does not win over an import in another namespace
  (§9.2); nested import paths resolve from the folder root, `..` rejected.
- Voice-def values must be integer literals (a `(def lvl 40)` constant or an
  expression is dropped); E_LET_SHADOWS_DEF only for voice/macro defs.
- Computed float levels on the driver (suspected: integer tables).

## 5. Why the value machine has this shape

Compile-time eval was designed in two rounds; **round 2 reversed two of round
1's decisions**, and the reasons are the load-bearing part:

- ~~"shrink the JS player's read-modify-write reads to match the Z80"~~ →
  **grow the driver instead.** A generic shadow read, derived from the existing
  write-descriptor table, makes every FM operator param readable.
  **`live ≡ hardware` is achieved upward, not downward.**
- ~~"`$`-bearing expressions must match a small closed lowering table"~~ → the
  table **opens.** With the target param itself as the accumulator, any
  left-linear expression over constants and `$slot`s lowers to existing opcode
  chains **with zero new opcodes**.

**The governing constraint, still true of `mmlispseq.c` and stated in no doc:**
eval is compile-time only and its output is static data. The driver gains **no
evaluator — only readers and flags.**

The vision it serves: **`def-val` slots are the score's input ports, eval
expressions are the wiring, and the sampling tiers are the rates** — the game
writes variables, the score declares how the music responds. The four tiers
(compile / tick / note-on / frame) are the unifying answer to "when is this
value read?"; `language.md` §8 and `driver.md` §6.4 show the mechanism but not
the model.

One verdict worth keeping: the **batched frame flush** was built and then
reverted — roughly 90 bytes for about a 1% reduction in writes. The revert is in
git; the ratio is not.

## 6. Live risks in the value machine

1. ~~**The hold sentinel collides with the pitch minimum.**~~ FIXED
   2026-09-22. `NOTE_PITCH.min` is −32768 and the i16 hold sentinel is
   `0x8000`, which both players decode as "advance, write nothing" — so a
   `:pitch` macro driven to its floor stopped writing, silently and with no
   diagnostic (measured: `[-32768]` stored as `[null, null]`, two pitch writes
   instead of six). The exporter now moves a real −32768 to −32767 and −128 to
   −127. Gate `m4-macro-floor`; note that **c-gate cannot see an encoder
   regression** — both players read the same stream — so the lock is the A/B
   baseline, which does move.
2. **A folded relative op is relative to the score-visible value**, so a host
   `SET_PARAM` in between is invisible to it. `(+ $P X)` is the explicit opt-in
   to host-relative behaviour.
3. **Multi-write chains touch the register between steps** — `W_EVAL_CHAIN_LONG`
   past about six ops.
4. **Inline stochastic sweeps (curve ids 8–11) fall back to a linear ramp on the
   driver** — a live ir↔drv divergence.
5. **The signal-⊕ region model is deliberately restricted** (equal step, no
   loop⊕one-shot, single release). loop⊕one-shot is the designed first
   relaxation and the prerequisite for *baked* AM; runtime AM is the scaled-macro
   flag.
6. **A second sigil (`@vel`) was considered and rejected** — more syntax for the
   same semantics. The `$` namespace carries several tiers and reserved-name
   checks keep them apart.
7. **An override looping curve on a pitch macro skews the A/B** by ±8 in the
   F-number at note boundaries, proven scale-independent. This was the only
   record of it; the file it used to point at never existed.

Deferred, with reasons: slot-fed macro-curve dynamics need a note-on curve
re-sampler, and sweep `:rate`/`:len` dynamics are still baked — both still warn
(`W_MMB_MACRO_SKIPPED`, `W_MMB_DYN_SWEEP_BAKED`). The scaled-macro form is
`(* signal $slot)` only, so it **cannot combine with `:pitch+`** in one macro.
