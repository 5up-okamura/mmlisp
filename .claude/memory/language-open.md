# The language and IR: the rulings, and why the value machine looks like this

Two things live here, because a session working on the language needs both:
**the 2026-09-26 syntax audit's rulings** (§1) and **the rationale behind
compile-time eval and the value machine** (§2–§3). `docs/language.md` carries
the shipped spec; this is only what the docs do not say. A language question
that needs the user's decision goes in a §1-style list here until it is
decided and built.

**An item is deleted from here as soon as it is fixed** and the repo carries
both the outcome and the reason — a second copy of a settled thing can only
rot.

## 1. Rulings from the 2026-09-26 syntax audit — do not re-propose

The rule behind that audit's rulings: `:key value` is a sticky
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
- **`(echo …)` is for the mucom import; `(delay …)` is what the user writes**
  (2026-10-15). echo replays one note and lengthens the phrase (mucom `\=`);
  delay is sticky and keeps the phrase's length. Offer delay first when a score
  wants an echo effect.

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

**The governing constraint** (language.md §7 says eval is compile-time only and
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

**Score-written values and song-wide sweeps** (2026-10-13). A `def-val` is
also the score's own variable — "外に出す必要がなくても変数として使いたい".
The user's rulings and why:

- **`:public` marks the host's slots; no mark = the score's own.** Chosen over
  `:private` once old scores were off the table ("既存のスコアのことを考える
  必要なし"): the game interface is a contract, so exposure is opted into.
  Public slots are numbered first so a private one never shifts the host's
  indices. Rejected spellings: `:host none`, a range meaning public.
- **Writes reuse the parameter syntax** (`:name v`, `:name+`, `(curve)`) and
  the existing PARAM opcodes, the slot being target VALn — no new opcode.
- **"制限はつけない、書いた通りに動く、でも破綻は困る"**: nothing is refused
  for being an odd combination; where the driver cannot follow, the compiler
  warns (`W_SWEEP_SLOTS`, `W_SONG_WRITE_RACE`) rather than refusing. The one
  arbitration rule: the latest write or sweep wins, host or score.
- **A song-wide value's sweep belongs to no channel** ("関係ないmacroが
  チャンネルに縛られることに違和感") — :master, :lfo-rate and VALn sweep in
  slots of their own, so an effect taking the writing channel does not stop
  them. **Song-wide macros were dropped, not moved** — a macro is a note's
  (key-on/key-off), and carrying one globally was too heavy for its use
  ("実装が重いならいらない"); `(macro :master …)` is an error.
- **16 slots stay** — the opcode space (0x10–0xFE) leaves room for a private
  range if a score ever needs more; grow it then, not before.

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
   F-number at note boundaries, proven scale-independent.
