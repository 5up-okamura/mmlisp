# The language and IR — the user's rulings and the reasons behind them

`docs/language.md` is the spec and the guide teaches it; this file keeps only
what they do not say: rulings not to re-propose, and why the value machine is
shaped as it is. A language question waiting on the user goes in §1 until it
is decided and built; a settled item that the repo records is deleted.

## 1. Rulings — do not re-propose

The rule behind the 2026-09-26 syntax audit: `:key value` is a sticky
parameter, `(form …)` an event or control, `#name` a position; an operator
suffix combines with the target's base (language.md §7.0).

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
- **`(echo …)` is for the mucom import; `(delay …)` is what the user writes**
  (2026-10-15). echo replays one note and lengthens the phrase (mucom `\=`);
  delay is sticky and keeps the phrase's length. Offer delay first when a score
  wants an echo effect.
- **PSG envelopes are macros, not a new def head** (2026-10-03): an envelope
  is already `(def name (macro …))`, and the only need was tooling, so the
  voice picker lists macro defs. Naming a head was hard because the thing was
  not a new concept.
- **No second sigil (`@vel`)** — more syntax for the same semantics; the `$`
  namespace carries every tier, kept apart by reserved-name checks.

## 2. Why the value machine has this shape

Compile-time eval was designed twice; the second round reversed two of the
first round's decisions, and those reasons are what will be argued again:

- **Grow the driver rather than shrink the preview.** Round 1 cut the JS
  player's read-modify-write reads down to what the Z80 could read; round 2
  gave the driver a generic shadow read, derived from the write-descriptor
  table, so every FM operator param is readable. `live ≡ hardware` is reached
  upward, not downward.
- **The lowering table is open.** Round 1 allowed `$`-bearing expressions only
  from a small closed table; with the target param itself as the accumulator,
  any left-linear expression over constants and `$slot`s lowers to existing
  opcode chains, with zero new opcodes.

**The governing constraint:** the driver gains no evaluator — only readers and
flags. A `$slot` is a value kind of the evaluator itself (mmlisp-eval.js
`Runtime`, the opcode chain kept symbolic like a signal), so the accumulator
lowering and the scaled macro `(* signal $slot)` are its arithmetic, with no
separate linearizer or pattern detector in mmlisp2ir.

The vision it serves: `def-val` slots are the score's input ports, expressions
the wiring, the sampling tiers the rates — the game writes variables, the
score declares how the music responds.

## 3. Score-written values (2026-10-13)

A `def-val` is also the score's own variable ("外に出す必要がなくても変数として
使いたい"). The rulings and why:

- **`:public` opts a slot into the host's interface**, chosen over `:private`
  once old scores were off the table ("既存のスコアのことを考える必要なし"): the
  game interface is a contract. Rejected spellings: `:host none`, a range
  meaning public.
- **Writes reuse the parameter syntax and the PARAM opcodes** (target VALn) —
  no new opcode.
- **"制限はつけない、書いた通りに動く、でも破綻は困る"**: no odd combination is
  refused; where the driver cannot follow, the compiler warns instead. The one
  arbitration rule: the latest write or sweep wins, host or score.
- **A song-wide value's sweep belongs to no channel** ("関係ないmacroが
  チャンネルに縛られることに違和感"), so an effect taking the writing channel
  does not stop it. **Song-wide macros were dropped, not moved** — a macro is a
  note's (key-on/key-off), and carrying one globally was too heavy for its use
  ("実装が重いならいらない").
- **16 slots stay** — the opcode space (0x10–0xFE) leaves room for a private
  range; grow it when a score needs it, not before.

## 4. Known limits

1. **A folded relative op is relative to the score-visible value**, so a host
   `SET_PARAM` in between is invisible to it; `(+ $P X)` is the explicit opt-in
   to host-relative behaviour.
2. **Loop⊕one-shot in the signal-⊕ region model** is the designed first
   relaxation and the prerequisite for *baked* AM; runtime AM is the
   scaled-macro flag.
3. **An override looping curve on a pitch macro skews the A/B** by ±8 in the
   F-number at note boundaries, proven scale-independent.
