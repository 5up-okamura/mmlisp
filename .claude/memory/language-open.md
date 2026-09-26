# The language and IR: what is open, and why the value machine looks like this

Two things live here, because a session working on the language needs both:
**the open questions** (§1–§2, from the 2026-09-18 audit) and **the design
rationale behind compile-time eval and the value machine** (§3–§4, merged from
`design-eval.md` 2026-09-22). `docs/language.md` carries the shipped spec; this
is only what the docs do not say.

**An item is deleted from here as soon as it is fixed** and the repo carries
both the outcome and the reason — a second copy of a settled thing can only
rot. Six went that way on 2026-09-22 (fm3-N per-operator levels, `:tl` as a
voiced level, abutting fm3-N notes, the `:keyon` leading step, `:gate 0`, the
macro hold sentinel); they live in `docs/driver.md` §7 / §13.4,
`docs/language.md` §10 / §17 and `docs/mmb.md` §15, each with its gate.

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
   Since 2026-09-24 this has teeth — Timer A really runs while CSM is on (it
   never did before: LOAD A was never set, so no CSM score had ever sounded),
   and a rest on `fm3-csm-rate` leaves it running at the last rate, so the
   buzz continues. Silencing mid-track needs a mechanism: clear LOAD A on a
   rate-track rest, or `:vol 0` meaning something to CSM (TL is the attack's
   start level in this mode, not an attenuation). The preview's mixer mute
   already holds Timer A; the language has no way to.
5. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
6. **`:hold`** (§11): unit undefined — it quantizes the LUT index, not steps.
7. **Note names vs defs** (§3): the doc says a def named like a note cannot be
   referenced; the code lets the def win. Error at def time?
8. **`(fm3 …)` notes beside fm3-N tracks**: no diagnostic.
9. **What the shipped eval work is called.** `docs/roadmap.md` frames v0.5 as
   the baseline and says the numbered freezes stopped there, matching
   CLAUDE.md — but score removal, `import`, compile-time eval and the value
   machine all landed after that line was drawn. If they are v0.6, it is the
   version table's last row and the sentence under it.

## 1b. Irregular rules, from the 2026-09-26 audit (each needs the user's call)

The rule behind all of them: `:key value` is a sticky parameter, `(form …)`
an event or control, `#name` a position; an operator suffix combines with the
target's base (§7.0). The judgment-free half of that audit has landed (IR
`TRIG`, head = `:prio` only, one value reader, wrong-channel errors,
`E_PRIO_LAYER_LOOP`, the formatter's glued-keyword repair), and so have the
first rulings: `#sus` / `#rel`, curve `:mode loop|shot`, one meaning per
definition head (`def` = snippet only — a named macro is a snippet too;
`def-voice` / `def-sample` / `def-val` = named data, a leading base name
replacing `:extend`), sample binding by name. **Decided:** no CALL/RET in the
language — naming is a source convenience, sharing is the encoder's job
(MACRO_TABLE / VOICE_TABLE dedup, the CALL/RET pass). **Decided, do not re-propose:** counted
`(go label N)` stays — flat, cross-form counted loops are wanted beyond the
mucom import; its post-merge rewrite is the feature's own cost. What is left
changes syntax:

5. **echo / delay** — in `(echo :vel+ 3 :by -1)` the `3` is a count, not an
   addend. Proposal `(echo 3 :vel+ -1)` / `(delay 3 :vel* 0.7 :time 8)`, the
   keyword's value being the per-tap step (a scalar, a vector of taps, or a
   curve); drops `:by` and the op-required errors. Examples asked for.
11. **`_xN` anchors of infinite `(x …)`** share the user label namespace.
    Proposal: an internal id no `#name` can spell. Examples asked for.

**Decided 2026-09-26, do not re-propose:** holds keep both `:len 0` (the
track waits for the host) and `:gate 0` (it does not) — two features; the
short relative forms `>` `<` `o±N` `v±N` stay (no free symbol pair for
velocity); `:wait` (a curve's own start delay) and `(wait …)` (a stage) are
different uses and both stay; `:csm-rate` and the `fm3-csm-rate` track differ in
use and range and both stay; `(glide …)` stays a form (two arities); gate is
§7.0's documented exception. Landed: `:oct*` and def-val `:min/:max` gone,
written lengths swing, an omitted `:from` = the current value (inline sweeps;
`E_CURVE_FROM` elsewhere), one macro-vector grammar (numbers and stages mix,
`const` gone).

Not a syntax question, but the next step of the value reader: `$` is still
recognised outside the evaluator (the runtime linearizer and
`detectScaledMacro`). Making `$slot` a symbolic evaluator value would merge
them.

## 2. Judgment-free but larger

- **Preview vs driver, pre-existing, found 2026-09-26** (each baselined or
  seen in A/B, none caused by that day's work): `:vel` before the first note
  — the preview writes carrier TL 0 at frame 0 and corrects it at frame 1;
  inline PARAM_SWEEPs (TL / VOL / PSG level) diverge in their frame writes
  (`m4-sweep-from-current` baselined at 62, the explicit-`:from` form
  identical); a macro with a looping stage then a release diverges (old
  all-stage spelling included).
- The live app registers its service worker in a `load` listener at the end
  of a module with top-level awaits, so on a fast load it never registers.

- Nf in one track converted at another track's mid-song tempo change (§4).
- Tick-0 tempo written as an expression is not seen by the Nf prescan.
- Imports: a local def does not win over an import in another namespace
  (§9.2); nested import paths resolve from the folder root, `..` rejected.
- E_LET_SHADOWS_DEF only for voice/macro defs (a snippet name gives E_LET_NAME).
- Computed float levels on the driver (suspected: integer tables).

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

## 4. Live risks in the value machine

1. **A folded relative op is relative to the score-visible value**, so a host
   `SET_PARAM` in between is invisible to it. `(+ $P X)` is the explicit opt-in
   to host-relative behaviour.
2. **Multi-write chains touch the register between steps** — `W_EVAL_CHAIN_LONG`
   past about six ops.
3. **Inline stochastic sweeps (curve ids 8–11) fall back to a linear ramp on the
   driver** — a live ir↔drv divergence.
4. **The signal-⊕ region model is deliberately restricted** (equal step, no
   loop⊕one-shot, single release). loop⊕one-shot is the designed first
   relaxation and the prerequisite for *baked* AM; runtime AM is the scaled-macro
   flag.
5. **A second sigil (`@vel`) was considered and rejected** — more syntax for the
   same semantics. The `$` namespace carries several tiers and reserved-name
   checks keep them apart.
6. **An override looping curve on a pitch macro skews the A/B** by ±8 in the
   F-number at note boundaries, proven scale-independent. This was the only
   record of it; the file it used to point at never existed.

Deferred, with reasons: slot-fed macro-curve dynamics need a note-on curve
re-sampler, and sweep `:rate`/`:len` dynamics are still baked — both still warn
(`W_MMB_MACRO_SKIPPED`, `W_MMB_DYN_SWEEP_BAKED`). The scaled-macro form is
`(* signal $slot)` only, so it **cannot combine with `:pitch+`** in one macro.
