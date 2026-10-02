# The language and IR: what is open, and why the value machine looks like this

Two things live here, because a session working on the language needs both:
**the open questions** (§1–§2, from the 2026-09-18 audit) and **the design
rationale behind compile-time eval and the value machine** (§3–§4, merged from
`design-eval.md` 2026-09-22). `docs/language.md` carries the shipped spec; this
is only what the docs do not say.

**An item is deleted from here as soon as it is fixed** and the repo carries
both the outcome and the reason — a second copy of a settled thing can only
rot.

## 1. Needs the user's decision (the driver sounds different from the editor)

1. **Glide longer than its note** (§14): slide faster to finish inside the
   note, or cut at the note end? Today both players let it run into later
   notes.
2. **`:vol* $slot`** (§8): preview multiplies by the slot as an integer,
   driver as 8.8 (`>> 8`) — which is the meaning?
3. **CSM "rest the rate source to silence"** (§15): no CSM_OFF is emitted.
   Since 2026-09-24 this has teeth — Timer A really runs while CSM is on (it
   never did before: LOAD A was never set, so no CSM score had ever sounded),
   and a rest on `fm3-csm-rate` leaves it running at the last rate, so the
   buzz continues. Silencing mid-track needs a mechanism: clear LOAD A on a
   rate-track rest, or `:vol 0` meaning something to CSM (TL is the attack's
   start level in this mode, not an attenuation). The preview's mixer mute
   already holds Timer A; the language has no way to.
4. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
5. **`:hold`** (§11): unit undefined — it quantizes the LUT index, not steps.
6. **Note names vs defs** (§3): the doc says a def named like a note cannot be
   referenced; the code lets the def win. Error at def time?
7. **`(fm3 …)` notes beside fm3-N tracks**: no diagnostic.
8. **A `:semi` / `:pitch` macro's first frame lands after the key-on in the
   driver** (seen 2026-10-03 while the FM drum kits briefly carried their
   pitch as a `:semi` macro; they now use `def-fm :key`): `drv-player.js`
   writes F-number at the note, key-on, then the macro's frame-0 pitch, all
   in one frame; the preview writes the macro's pitch before the key-on. On
   hardware that is the pair transport's spacing of two writes —
   microseconds at the wrong pitch — but the orders differ. Decide whether
   the sequencer should run a note's frame-0 macros before its key-on.

## 1b. Rulings from the 2026-09-26 syntax audit — do not re-propose

Every item of that audit has landed (the results are in `docs/language.md`)
or was decided against changing. The rule behind it: `:key value` is a sticky
parameter, `(form …)` an event or control, `#name` a position; an operator
suffix combines with the target's base (§7.0). Kept as they are, by ruling:

- **No CALL/RET in the language** — naming is a source convenience, sharing is
  the encoder's job (MACRO_TABLE / VOICE_TABLE dedup, the CALL/RET pass).
- **Counted `(go label N)` stays** — flat, cross-form counted loops are wanted
  beyond the mucom import; its post-merge rewrite is the feature's own cost.
- **Holds keep both `:len 0`** (the track waits for the host) **and `:gate 0`**
  (it does not) — two features.
- **The short relative forms `>` `<` `o±N` `v±N` stay** (no free symbol pair
  for velocity).
- **`:wait` and `(wait …)` both stay** (a curve's own start delay vs a stage);
  so do **`:csm-rate` and the `fm3-csm-rate` track** (different use and range).
- **`(glide …)` stays a form** (two arities); gate is §7.0's documented
  exception.

## 2. Judgment-free but larger

- **Preview vs driver.** The 2026-09-26/27 sweep closed every divergence
  found (the repo carries each fix and its gate: the sweep engine, macro
  releases and the tick clock, the keyon restart and echo tail, PSG level
  macros and sweeps frame by frame, tempo sweeps and tempo quantization,
  cross-track event order, replay state). What the A/B still shows is the
  pitch model (float `pow` vs the driver's cent LUT, ±1 F-number — the
  `m2b-pitch` residue). Computed levels were decided: the driver holds
  velocity in eighths (driver-decisions.md §9).

## 3. Why the value machine has this shape

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
evaluator — only readers and flags.** Since 2026-09-26 a `$slot` is a value
kind of the evaluator itself (mmlisp-eval.js `Runtime`: the opcode chain,
kept symbolic like a signal), so the accumulator lowering and the scaled
macro `(* signal $slot)` are its arithmetic — no separate linearizer or
pattern detector in mmlisp2ir.

The vision it serves: **`def-val` slots are the score's input ports, eval
expressions are the wiring, and the sampling tiers are the rates** — the game
writes variables, the score declares how the music responds. The four tiers
(compile / tick / note-on / frame) are the unifying answer to "when is this
value read?"; `language.md` §8 and `driver.md` §6.4 show the mechanism but not
the model.

One verdict worth keeping: the **batched frame flush** was built and then
reverted — roughly 90 bytes for about a 1% reduction in writes. The revert is in
git; the ratio is not.

## 4. Live risks in the value machine

1. **A folded relative op is relative to the score-visible value**, so a host
   `SET_PARAM` in between is invisible to it. `(+ $P X)` is the explicit opt-in
   to host-relative behaviour.
2. **Multi-write chains touch the register between steps** — `W_EVAL_CHAIN_LONG`
   past about six ops.
3. **The signal-⊕ region model is deliberately restricted** (equal step, no
   loop⊕one-shot, single release). loop⊕one-shot is the designed first
   relaxation and the prerequisite for *baked* AM; runtime AM is the scaled-macro
   flag.
4. **A second sigil (`@vel`) was considered and rejected** — more syntax for the
   same semantics. The `$` namespace carries several tiers and reserved-name
   checks keep them apart.
5. **An override looping curve on a pitch macro skews the A/B** by ±8 in the
   F-number at note boundaries, proven scale-independent. This was the only
   record of it; the file it used to point at never existed.

Deferred, with reasons: slot-fed macro-curve dynamics need a note-on curve
re-sampler, and sweep `:rate`/`:len` dynamics are still baked — both still warn
(`W_MMB_MACRO_SKIPPED`, `W_MMB_DYN_SWEEP_BAKED`). The scaled-macro form is
`(* signal $slot)` only, so it **cannot combine with `:pitch+`** in one macro.
