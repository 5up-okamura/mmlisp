# The language and IR: what is open, and why the value machine looks like this

Two things live here, because a session working on the language needs both:
**the open questions** (§1, from the 2026-09-18 audit, and the 2026-09-26
syntax audit's rulings) and **the rationale behind compile-time eval and the
value machine** (§2–§3). `docs/language.md` carries the shipped spec; this is
only what the docs do not say. Tidied 2026-10-09; the voice picker's PSG
ruling moved in from `plan-voice-picker`.

**An item is deleted from here as soon as it is fixed** and the repo carries
both the outcome and the reason — a second copy of a settled thing can only
rot.

## 1. Needs the user's decision (the driver sounds different from the editor)

1. **`:vol* $slot`** (§8): preview multiplies by the slot as an integer,
   driver as 8.8 (`>> 8`) — which is the meaning?
2. **CSM "rest the rate source to silence"** (§15): no CSM_OFF is emitted.
   Since 2026-09-24 this has teeth — Timer A really runs while CSM is on (it
   never did before: LOAD A was never set, so no CSM score had ever sounded),
   and a rest on `fm3-csm-rate` leaves it running at the last rate, so the
   buzz continues. Silencing mid-track needs a mechanism: clear LOAD A on a
   rate-track rest, or `:vol 0` meaning something to CSM (TL is the attack's
   start level in this mode, not an attenuation). The preview's mixer mute
   already holds Timer A; the language has no way to.
3. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
4. **A `:semi` / `:pitch` macro's first frame lands after the key-on in the
   driver** (seen 2026-10-03 while the FM drum kits briefly carried their
   pitch as a `:semi` macro; they now use `def-fm :key`): `drv-player.js`
   writes F-number at the note, key-on, then the macro's frame-0 pitch, all
   in one frame; the preview writes the macro's pitch before the key-on. On
   hardware that is the pair transport's spacing of two writes —
   microseconds at the wrong pitch — but the orders differ. Decide whether
   the sequencer should run a note's frame-0 macros before its key-on. A PSG
   glide shows the same thing (seen 2026-10-09 building `m4-glide-lag`): the
   driver writes the note's plain tone, then the glide's start, in the key-on
   frame, and the preview runs a frame ahead — most of that score's PSG A/B
   mismatches, frozen in the baseline.

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

## 2. Why the value machine has this shape

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

**The governing constraint** (the roadmap says eval is compile-time only and
bakes to static data; this is the part it does not say): the driver gains **no
evaluator — only readers and flags.** Since 2026-09-26 a `$slot` is a value
kind of the evaluator itself (mmlisp-eval.js `Runtime`: the opcode chain,
kept symbolic like a signal), so the accumulator lowering and the scaled
macro `(* signal $slot)` are its arithmetic — no separate linearizer or
pattern detector in mmlisp2ir.

The vision it serves: **`def-val` slots are the score's input ports, eval
expressions are the wiring, and the sampling tiers are the rates** — the game
writes variables, the score declares how the music responds. The four tiers
(compile / tick / note-on / frame) are the unifying answer to "when is this
value read?" (guide §18b).

**PSG envelopes are macros, not a new def head** (2026-10-03). A `def-env` /
`def-macro` was discussed and rejected: an envelope is already `(def name
(macro …))`, the one form of a named macro, and the only need was tooling — so
the voice picker lists macro defs instead. Naming the head was hard because
the thing was not a new concept.

## 3. Live risks in the value machine

1. **A folded relative op is relative to the score-visible value**, so a host
   `SET_PARAM` in between is invisible to it. `(+ $P X)` is the explicit opt-in
   to host-relative behaviour.
2. **The signal-⊕ region model is deliberately restricted** (equal step, no
   loop⊕one-shot, single release). loop⊕one-shot is the designed first
   relaxation and the prerequisite for *baked* AM; runtime AM is the scaled-macro
   flag.
3. **A second sigil (`@vel`) was considered and rejected** — more syntax for the
   same semantics. The `$` namespace carries several tiers and reserved-name
   checks keep them apart.
4. **An override looping curve on a pitch macro skews the A/B** by ±8 in the
   F-number at note boundaries, proven scale-independent. This was the only
   record of it; the file it used to point at never existed.
