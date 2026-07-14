# v0.6 Phase 3 — compile-time eval: settled design

Status: **design settled 2026-07-12** (two design rounds; the five open
questions from [plan-v0.6.md](plan-v0.6.md), the operator A/B question, and
the runtime-boundary question are decided below). Implementation has NOT
started — the ordered plan with per-step gates is §12. This file is the
normative design record; language.md is amended as the implementation lands.

Round 2 (user-driven) materially upgraded the runtime side and **reverses two
round-1 decisions**:

- ~~"shrink the JS player's RMW reads to match the Z80"~~ → **grow the Z80**:
  a generic shadow read derived from the existing write-descriptor table
  makes all FM op params RMW-readable (§4.1). live ≡ hardware is achieved
  upward, not downward.
- ~~"`$`-bearing expressions must match a small closed lowering table"~~ →
  the table **opens**: with the param itself as the accumulator, any
  left-linear expression over consts and `$slots` lowers to existing opcode
  chains with zero new opcodes (§4.3). `E_EVAL_NOT_LOWERABLE` shrinks to a
  short, explicit list.

Settled decisions (rationale inline):

- **Escape syntax**: none — list-head dispatch; the evaluator runs **in-walk**
  inside `compileChannelBody`, not as a pre-pass (§1).
- **Types**: scalar / signal / stream; signals stay *symbolic* wherever
  possible for LUT byte-identity (§2).
- **let**: form-level, sequential; def-functions and `for` are Phase 4, the
  seam (env chain + builtin registry) is designed now (§7).
- **Determinism**: eval is pure; stochastic curves gain a `:seed` parameter
  (compile-time only, Z80 cost zero) (§3.1).
- **Boundary**: the unifying model is **sampling tiers** — a `$ref` is a
  variable; what differs is *when it is read*: compile / tick / note-on /
  frame (§4.0). Static folds; runtime forms lower via the value machine
  (§4.3-4.5); what cannot lower is a compile error, never bake+warn. The
  legacy curve-`dyn` bake+warn path is kept but fenced (§4.6).
- **Operators**: Option B — the `+`/`*` suffixes stay as pure desugaring onto
  one arithmetic rule, with built-in `$`-references naming each base (§5).
- **Data size**: CALL/RET + an encode-time dedup pass are confirmed feasible
  (control-stack slot already reserved in the frozen TCB layout) (§9).
- **Z80 budget**: measured, funded, with a reduction ladder (§10).

Governing constraints (updated in round 2): eval itself is compile-time only
and its output is static data; the runtime carriers are `$slot` reads through
a small, **measured** driver budget (§10) — the driver gains no evaluator,
only readers and flags; `cd drv && npm run verify:all` stays 0-diff at every
step; the note stream stays terse and literal.

Line references are against 18abe79 (`live/src/mmlisp2ir.js` unless noted);
re-verify before relying on exact numbers.

---

## 0. Summary

Eval is added **in-walk**. A single evaluator entry point
(`evalNode(node, env, ctx)`, new module `live/src/mmlisp-eval.js`) is called
from the two places `()` forms already reach `compileChannelBody`: **value
positions** (the `:keyword` default case at :2506 and the `parseCurveSpec`
call sites) and **item positions** (the list-branch head switch, just before
`E_UNKNOWN_LIST` at :3227). Values are three types: **scalar** (float),
**signal** (the existing macro/curve spec objects, kept *symbolic* whenever
possible so LUTs stay byte-identical), and **stream** (spliced note items —
MVP produces streams only in place, via `let` bodies and `(note …)`).
Expressions whose leaves are all static fold — including relative operators
against the **compile shadow** (§4.2). Expressions containing `$refs` lower
through the **value machine** (§4.3): the target param is the accumulator,
`$slots` are the variables, and the existing PARAM_SET / ADD / MUL /
FROM_VAL / ADD_VAL / MUL_VAL opcodes are the instruction set — made general
by one small driver addition, the generic shadow read (§4.1). Per-note and
per-frame runtime variation ride the macro engine (dyn params, additive
flag, scaled flag — §4.4). All five operator-suffix families become
desugarings into eval forms. IR shapes do **not** change; docs/ir.md is
untouched by the MVP.

The design vision: **`def-val` slots are the score's input ports, eval
expressions are the wiring, and the sampling tiers are the rates** — the
game writes variables; the score declares how the music responds.

```lisp
(def-val tension 0 :from 0 :to 100)      ; the game writes one variable

(fm1 brass
     :tl1 (- 40 (* $tension 0.2))        ; brightness follows tension (tick)
     (macro :pitch (* (sin :rate 6) $tension))  ; vibrato depth (frame)
     c4 e g e ...)
```

## 1. Grammar & dispatch

### 1.1 The quasiquote rule (normative)

- **Outside an eval form**: atoms are literal note-stream/directive tokens
  (unchanged). A `()` list is a known structural form, a parametric-def call
  (consumed earlier by expansion), an eval form, or an error.
- **Inside an eval form**: atoms are *evaluated* — numeric atoms are scalars
  (`parseNumberLike`, :1772), `$name` atoms are value references, bare
  identifiers resolve against the `let` environment, keywords (`:from` etc.)
  remain kwarg syntax for builtins. A note/length/rest token as an operand is
  `E_EVAL_OPERAND` (no implicit note→number coercion; `(note …)` goes the
  other way).

### 1.2 Evaluable heads (MVP)

| Head | Positions | Returns |
|---|---|---|
| `+ - * /` | value, expression | scalar / signal (lifting, §2.3) |
| `min max abs round floor` | value, expression | scalar only (all fold) |
| `let` | item, value, expression | splices body (item) / body result (value) |
| `note` | item | one NOTE_ON (stream of 1) |
| `ticks`, `frames` | length positions only | unit-tagged scalar (§2.4) |
| curve names (`CURVE_NAMES`, :75) | value, expression | symbolic signal (§3) |

**Excluded from MVP** (Phase 4; the seam is the builtin registry, one
`Map<string, builtin>`): `if` + comparisons, `for`/generators, evaluating
`(def (name args) body)`. Without functions/iteration, `if` over static
values has no use that editing doesn't cover, and comparisons alone add six
heads. Each is a one-entry registry addition later.

### 1.3 Precedence (list-head dispatch)

For a `()` form in a channel body, highest first:

1. **User defs / parametric defs** — consumed by `expandRoots` (:3621)
   *before* the body walk; user names shadow everything. New reserved-name
   checks in `collectDefs` (:3358): a def/paramDef named after an eval builtin
   → `E_DEF_RESERVED`; a paramDef shadowing a curve name →
   `W_DEF_SHADOWS_BUILTIN` (it already shadows today; warning only).
2. **Structural heads** — the existing switch, unchanged: `t` (:2795),
   `x` (:2865), `go` (:2926), `echo` (:2982), `delay` (:3037),
   `glide` (:3123), `macro` (:3141), `param-set` (:3198).
3. **Eval item heads** — `let`, `note`. New branch just before
   `E_UNKNOWN_LIST` (:3227).
4. Everything else → `E_UNKNOWN_LIST`, as today. Curve names in *item*
   position stay unknown (a signal is meaningless as a note-stream item).

**Value positions**: curve head (`parseCurveSpec`, :1479) → eval head
(`evalValue`) → the position's literal parsers → error. `requireCurve`'s
`E_UNKNOWN_CURVE` (:1494) fires only after the eval-head check fails, and is
generalized to `E_EVAL_UNKNOWN_HEAD` (near-miss curve-name hinting kept).

### 1.4 In-walk, not a pre-pass (decision + rationale)

`expandRoots`/`expandNode` (:3579-3626) stays pure token substitution. The
evaluator runs inside `compileChannelBody`, which gains an `env` parameter
(lexical chain `{bindings: Map, parent}`) threaded through its recursions
(the `x`-loop at :2878/:2902 and the `t` handler). Rationale:

- Operator desugaring needs track state: `:vel+` folds against sticky
  `defaultVel` (:2297), `:oct+` against `defaultOct` (:2237) — per-position,
  order-dependent; a pre-pass cannot see it. The compile shadow (§4.2)
  extends this to all params.
- Unit resolution needs `currentTempo` (mid-track `:tempo`, :2412).
- Rounding/clamping of a materialized signal needs the binding target
  (`clampForTarget`, ir-utils.js:80).
- `let` scoping must follow the body walk (loops, tuplets).
- Diagnostics get `trackName` + position for free.

Track *head* options are not evaluated in MVP (all are writable as body
directives; documented).

### 1.5 Errors

Unknown head in item position: `E_UNKNOWN_LIST` (unchanged). In value
position, and anywhere inside an eval form: `E_EVAL_UNKNOWN_HEAD` — no
fall-through to literal interpretation. Nesting depth guard 32
(`E_EVAL_DEPTH`), independent of the def-expansion depth-16 guard.

## 2. Value model

### 2.1 Scalar

A JS double. Floats are legal throughout a computation; integerization
happens **only at the existing binding sites**, each with its existing rule
(this keeps IR byte-identical): `:oct`/`:vel` fold = round+clamp
(:2240/:2300); PARAM_SET = round + `clampForTarget` (:2585); curve
`:from/:to` stay float (:1629); `:tempo` stays float; macro step values =
int + `clampForTarget` (:1393); MMB LUT sample = round **then** clamp
(export-mmb.js:240).

### 2.2 Signal

A signal **is** the existing spec object (`{type:"curve"|"stages"|"steps",…}`,
ir.md §6), in one of two representations:

- **Symbolic** (curve/stages): produced by curve builtins; identical to
  `parseCurveSpec` output. Sampling stays deferred to today's consumers (live
  samples float per frame; MMB samples at `:step` via `sampleCurveValues`,
  export-mmb.js:234). *This is the LUT-identity mechanism*: a symbolic signal
  reaching a macro binding takes exactly today's code path.
- **Materialized** (`steps` with float values + a `step` clock): produced only
  when arithmetic cannot stay symbolic (signal⊕signal). Values stay float in
  the spec; round + `clampForTarget` apply **once at the binding site**
  (matches the level-model "sum float, quantize once" rule and the
  export-mmb.js:240 round-then-clamp order). The live player already plays
  float step values; the MMB `steps` lowering gains one `Math.round`
  (a no-op for all existing integer step specs — 0-diff gate).

### 2.3 Lifting rules (S = scalar, G = signal)

- `S ⊕ S` → fold. `/` by zero → `E_EVAL_DIV_ZERO`.
- `S ⊕ G`, ⊕ ∈ {+, −, ×, ÷-by-scalar} — **affine, stays symbolic**: reuse
  `mapMacroValues` (:919) to shift/scale from/to/step values in place.
  `(+ (sin :from -40 :to 40 :len 8) 10)` ≡ `(sin :from -30 :to 50 :len 8)` —
  byte-identical LUT; the same fold works on inline PARAM_SWEEPs (still
  lowerable to driver curve ids, mmb.js:224). Affinity holds because sampling
  is `from + (to−from)·unit`. Non-affine `S ÷ G` →
  `E_EVAL_SIGNAL_NONAFFINE`. Folded values stay unclamped floats until the
  binding site (like today's relative macros, comment at :1325).
- `G ⊕ G` → **materialize pointwise** on a common timeline. MVP restrictions
  (each a specific error):
  - Equal step clock required (`E_EVAL_SIGNAL_STEP`); the default `1f` makes
    the common case pass. (gcd-clock auto-resampling is post-MVP.)
  - Symbolic operands are sampled with **exactly** the export-mmb.js:284-291
    phase formulas through `sampleCurveUnit` (ir-utils.js:468) — without the
    per-sample round/clamp (deferred to binding, §2.2).
  - Region composition: one-shot⊕one-shot → one-shot, length = max, shorter
    extends with its final value (what the macro engine does after `count`);
    loop⊕loop → loop, period = lcm ≤ 255 steps else `E_EVAL_SIGNAL_LEN`,
    `loopStart = 0`; **loop⊕one-shot → `E_EVAL_SIGNAL_SHAPE`** in MVP (the
    honest result — one-shot attack riding a loop, then loop-only sustain —
    is expressible in the region model only when the one-shot length is a
    multiple of the loop period; the general case needs phase-continuation
    logic; first post-MVP relaxation, prerequisite for *baked* `(* env lfo)`
    AM — note the *runtime* AM shape `(* G $slot)` is instead covered by the
    scaled-macro flag, §4.4); `release` (`:off`) regions on at most one
    operand (`E_EVAL_SIGNAL_SHAPE` otherwise), boundary carried over.
  - Hold sentinels (`_` → null steps, :1395): resolved to the held (previous)
    value before combining — semantically exact (`_` = "write nothing, the
    register keeps the previous value"). A *leading* hold (`:wait` prefixes,
    export-mmb.js:276) holds the pre-macro base, unknowable at compile time →
    `E_EVAL_SIGNAL_HOLD`. Materialized outputs therefore never contain the
    0x80/0x8000 sentinel.
  - Width is not a signal property: i8 vs i16 is decided per target at intern
    time (flags bit0 = NOTE_PITCH, export-mmb.js:359).

### 2.4 Units for scalars

**Bare numbers in eval expressions are dimensionless.** No unit algebra.
Length-token atoms (`8`, `8.`, `16t`, `4f`, `1/2`) are not operands
(`E_EVAL_OPERAND`). Bridging into length positions is explicit:

- `(ticks expr)` / `(frames expr)` — evaluate to a scalar, round, ≥ 0; usable
  wherever a length token is accepted, via a new `parseLengthValue(node,
  inherited, bpm, env, ctx)` wrapping `parseLengthToken` (:298), substituted
  at call sites incrementally (MVP: curve `:len`, macro `:step`/`:len`,
  `:gate`; the rest follow mechanically).
- A *bare* eval expression in a length position is `E_EVAL_UNIT_REQUIRED` —
  reading `:len (+ 4 4)` as "denominator 8" (consistent with `:len 8`) is a
  semantic trap; `(ticks …)`/`(frames …)` costs 7 characters and removes it.
- Pitch: cents/semitones are plain numbers in the target's unit, as today.

`t` is already the tuplet head — hence `ticks`/`frames`, not `t`/`f`.

### 2.5 Stream

Defined for Phase 4; in MVP streams never exist as *values*. `let` in item
position compiles its body in place (inline splice); `(note e [len])` emits
one note. Nothing can bind or return a stream (`E_LET_BINDING`). This keeps
the note stream literal and defers the real design (generator laziness, the
`(x 4 c >)` bake-once sticky-state rule, language.md §13) to the `for` pass.

**`(note expr [len])`**: expr → scalar, rounded → MIDI number (C4 = 60,
matching `pitchToMidi`, ir-utils.js:119); converted by a new
`midiToPitchName` inverse (sharps spelled `+`) and sent through
`emitNoteForTrack` (:558) so ties, glide, shuffle, PCM, and macros behave
identically to a literal note. Optional second arg: length token or
`(ticks/frames …)`. Out of range → `E_NOTE_RANGE`.

## 3. Curves as library functions

- Each `CURVE_NAMES` head becomes a builtin whose implementation **is**
  `parseCurveSpec` (:1479) — same kwarg parsing, same diagnostics, same `dyn`
  recording for bare `$refs` in `:from/:to/:rate/:len` (:1624-1653), same
  output spec. One added capability: kwarg *values* may be eval expressions,
  evaluated to scalars first (a `$ref` inside a computed kwarg is
  `E_EVAL_NOT_LOWERABLE` — the `dyn` mechanism stays bare-`$ref`-only).
- **Byte-identity guarantee**: a curve reaching a binding un-arithmetic'd or
  affine-folded is a symbolic spec → MMB samples it via `sampleCurveValues`
  with the same clamp/round and the same intern key (`internMacro`,
  export-mmb.js:340). Gate: compile the folded form and its hand-written
  equivalent; assert equal MACRO_TABLE bytes.
- `parseCurveSpec` and all direct callers stay; `parseMacroSpec` (:1317) is
  structurally unchanged — the macro value position routes `()` non-curve
  heads to `evalValue` and accepts a signal or the deferred-base forms of
  §4.4. `[…]` step vectors, multi-stage vectors, scalars, `none` untouched.

### 3.1 Stochastic curves: `:seed`

`noise` / `pink` / `perlin` / `brown` gain **`:seed N`** (u32; default
0xDEAD = full backward compatibility, byte-identical output for seedless
sources). Implementation: `buildStochasticLuts(1024, seed)`
(ir-utils.js:302) memoized per seed; `supportsParamKey` (:1555) admits
`seed` for the four stochastic heads.

Why this is free on the Z80: `STOCHASTIC_LUTS` (ir-utils.js:361) are a
**compile-time JS construct only** — not part of the MMB LUT_TABLE, and
macro-position stochastic curves are pre-sampled to explicit value blobs at
export. The driver replays values; the seed is invisible to it. Costs: Z80
code 0 B, RAM 0 B; distinct seeds intern distinct MACRO_TABLE blobs (ROM);
compile-time regeneration memoized. Determinism holds — the seed is source
text. Retires the parked roadmap item "Reproducible random sequence by
seed-indexed LUT traversal".

Design note: "seed = start index into the fixed table" is essentially what
`:phase` already does and produces correlated (shifted) sequences; RNG
regeneration gives statistically independent sequences, so it is the primary
mechanism and `:phase` remains the shift tool.

Related pre-existing asymmetry (recorded): stochastic curves in **inline
sweep** position lower to driver curve ids 8-11, which `curveUnit8`
(mmb.js:255) currently evaluates as the default linear ramp ("how they lower
is an M3 decision", mmb.js:214). Macro-position stochastic curves are exact
on both. `:seed` neither helps nor hurts this.

## 4. The value machine — compile/runtime boundary

### 4.0 Sampling tiers (the unifying model)

**A `$ref` is a variable; what differs is when it is read.** Every runtime
surface in the language is one of four tiers:

| Tier | Read at | Mechanism | Status |
|---|---|---|---|
| compile | compile time | constant folding + the compile shadow (§4.2) | new, 0 driver B |
| tick | event dispatch | FROM_VAL/ADD/MUL/ADD_VAL/MUL_VAL chains over the param-as-accumulator (§4.3), enabled by the generic shadow read (§4.1) | read is new (~35-55 B) |
| note-on | note/macro fire | curve `:from/:to/:rate/:len` ← slot (the tracked M3 dyn slice) | designed, unimplemented |
| frame | every 60 Hz frame | additive macro flag (landed; Z80 branch pending ~50-60 B) + **scaled macro flag** (§4.4, new ~30-40 B) | additive pending / scaled new |

Built-in `$`-references (added to `resolveValRef`, :986):

| Ref | Tier | Meaning |
|---|---|---|
| `$vel`, `$oct` | compile | track state at this position — always foldable |
| `$vel` inside a macro value | per-note | the note's velocity at note-on (§4.4) |
| `$pitch` | frame | the channel's live pitch offset (additive base) |
| `$<target>` self-ref (e.g. `$tl1` in a `:tl1 …` write) | tick | current shadow value (RMW base) |
| `$time` | tick/frame | slot 0xFF (unchanged) |
| `$name` | tick/note-on/frame | def-val slot (unchanged) |

`def-val` names colliding with built-ins (`time`, `vel`, `oct`, `pitch`,
`semi`, hw-param stems) → `E_DEFVAL_RESERVED` (today only the `$` prefix is
rejected, :3379).

### 4.1 Generic shadow read (driver: the one keystone addition)

Today Z80 `read_param` (drv/src/mmlispdrv.z80:3595, 72 B) reads MASTER /
NOTE_PITCH / VOL / VEL / GATE / FM voiced TL1-4; every other target reads 0
**silently** (`:ar1+ 5` works in the live player, is 0-based on hardware).
Round 1 proposed shrinking the JS player to match; round 2 reverses this:

The M3 table-drive refactor left the exact tool needed: `op_param_tab`
(mmlispdrv.z80:2108) holds `{reg_base, keep_mask, val_mask, shift}` per FM
op-param family, and `generic_op_param` (:2123) already does
shadow-read → mask → merge → write via `ym_shadow_read`. **A generic read is
the inverse of the same table row**:

```
read_op_param:            ; A = target 0x16..0x3D → HL = current field value
    ; shared prologue with generic_op_param: row lookup + op_e → E = reg addr
    call ym_shadow_read   ; A = shadow byte
rop_sh:                   ; shift right by row.shift
    dec c
    jp m,rop_done
    srl a
    jr rop_sh
rop_done:
    and val_mask
    ld l,a
    ld h,0
    ret
```

Cost ~35-55 B (range branch in `read_param` ~10 B + body, less if the
prologue is factored out of `generic_op_param`). Result: **AR/DR/SR/RR/SL/
KS/ML/DT/SSG/AMEN become RMW-readable** — the silent-0 trap is *fixed*, not
fenced. ALG/FB/PAN (packed in $B0/$B4) are the same pattern with a 2-3 row
mini-table (follow-up, ~10-15 B). `E_PARAM_NOT_READABLE` remains only for
the genuinely stateless leftovers (LFO rate, noise mode, CSM rate — document
the exact list at implementation).

Semantics note: reading the shadow returns the last *written* field value —
including host `SET_PARAM` writes — which is exactly the base `:ar1+` wants.
TL stays special (voiced TL in `CHS_VTL`, because the register TL includes
vel/vol attenuation) — the existing TL branch is already correct.

### 4.2 The compile shadow (tier: compile, 0 driver bytes)

The compiler walks each track's events in order, so it can track the
score-visible current value of **every** param — the generalization of what
`trackState.defaultVel`/`defaultOct` already do. Voice loads seed it (voice
kwMaps are known at compile time). Rules:

- A relative op whose base is **statically known** folds to an absolute
  `PARAM_SET` at compile time — `:ar1+ 5` after `(fm1 brass …)` compiles to
  `PARAM_SET AR1 (brass.ar1 + 5)`. Zero runtime cost, works on today's
  driver.
- The base becomes **unknown** (shadow entry poisoned) after: a write from a
  `$slot` (`:ar1 $x`), a sweep targeting the param, or entry into a section
  reachable with divergent state. Then the op lowers to the runtime RMW
  chain (§4.3) — which now works because of §4.1.
- Host `SET_PARAM` is invisible to the compiler by nature; the documented
  semantics of a *folded* relative op is "relative to the score-visible
  value". Scores that want host-write-relative behavior use the runtime
  form explicitly (`:ar1 (+ $ar1 5)` forces the RMW lowering).
- Infinite-loop boundary (`(go label)`): if the shadow at the jump target
  differs from the shadow at the jump source for a param that a folded
  relative op depended on, diagnose (`E_SHADOW_LOOP_DIVERGENT`) — this also
  doubles as a determinism check.

### 4.3 Left-fold lowering (tier: tick) — the open table

**The target param is the accumulator.** After normalization (constants
folded via §4.2, commutative reorder), any *left-linear* expression — one
whose parse tree is a chain `((e0 op1 e1) op2 e2) …` with each `ei` a
constant or `$slot` — lowers to a same-tick opcode sequence:

```lisp
:tl1 (+ $a (* $b 2))
;; PARAM_FROM_VAL tl1, b      ; tl1 ← $b
;; PARAM_MUL      tl1, 2.0    ; tl1 ← tl1 × 2
;; PARAM_ADD_VAL  tl1, a      ; tl1 ← tl1 + $a
```

- Seed: constant → `PARAM_SET`; `$x` → `PARAM_FROM_VAL`; self-ref `$P` →
  nothing (start from the current value; requires P readable per §4.1).
- Each subsequent term: `+ const` → `PARAM_ADD`; `+ $x` → `PARAM_ADD_VAL`;
  `× const` → `PARAM_MUL` (8.8); `× $x` → `PARAM_MUL_VAL`; `− const` →
  `PARAM_ADD` negative; `÷ const` → `PARAM_MUL` reciprocal.
- Distribution rewrite: `(* (+ $a $b) k)` → `(+ (* $a k) (* $b k))` when it
  linearizes the tree (compiler-side algebra, floats fold exactly at
  compile time for the constant parts).
- Same-tick sequences dispatch in stream order on both players and the Z80 →
  live ≡ MMB. Loop-safe: the seed (SET/FROM_VAL) re-seeds each firing.
  Caveat (documented): intermediate values hit the register between writes
  within one frame's dispatch — inaudible, but each write costs a BUSY-wait
  on hardware; the compiler warns past ~6 ops (`W_EVAL_CHAIN_LONG`).

**What still errors** (`E_EVAL_NOT_LOWERABLE`, the honest list):

- `(- E $x)` / `(/ E $x)` — subtract-from / divide-by a slot: no SUB_VAL
  opcode and PARAM_MUL's factor is unsigned 8.8. Workaround documented
  (negate at the source: a slot declared with an inverted range). SUB_VAL is
  a ~15 B reserve if demand appears.
- Non-linearizable shapes needing a true temporary — e.g.
  `(* (+ $a $b) (+ $c $d))`. Covered by the VAL-op reserve (§4.5).
- `× $x` / chains on i16 targets (NOTE_PITCH, TEMPO_SCALE) — the 8.8
  multiply uses the current value's low byte only (mmlispdrv.z80:3748;
  opcodes.md caveat). Pitch expressions ride the macro tiers instead.
- Cross-param reads (`:tl1 (+ $tl2 5)`) — only self-refs have an RMW opcode.

### 4.4 Macro value position (tiers: note-on, frame)

| Shape | Lowering |
|---|---|
| G | override macro — unchanged |
| affine(G, S) | folded macro — LUT-identical (the `(+ (sin) 10)` case) |
| G₁ ⊕ G₂ (§2.3) | materialized `steps` macro |
| expression whose only deferred ref is `$vel` (P = vel) | **per-note eval**: the spec carries the expression; `makeNoteArgs` (:968) evaluates it with `$vel` = the note's velocity, yielding a static signal per note-on. Subsumes `scaleMacroValues`/`addMacroValues` (:941-947) — the special cases `(* G (/ $vel 15))` and `(+ G $vel)` |
| bare `$refs` in curve `:from/:to/:rate/:len` | note-on tier: the M3 dyn slice (slot read at macro/sweep fire). Per-note-rare work — can ride an overlay (the PCM per-note setup precedent, driver.md §14) |
| `(+ G $pitch)` (P ∈ {pitch, semi}) | **additive macro flag** (landed backend: MMB flags bit1, export-mmb.js:359; Z80 branch pending — §12 step 8): per frame `offset + sample`, no store-back |
| `(+ G $x)` (P ∈ {pitch, semi}) | composite: `PARAM_FROM_VAL NOTE_PITCH src:x` at this tick **+** additive macro — per frame `live_offset + sample` where the offset was seeded from the slot. The `(+ (sin) $detune)` case. Slot sampled at the directive's tick (re-fires in loops) |
| `(* G $x)` (any macro target) | **scaled macro flag** (new, frame tier): per frame `write((sample × slot) >> 8)` — MMB descriptor flags bit2 + slot byte; Z80: flag branch in the macro stepper + `mul16x8_sh8` (already resident, :3862). ~30-40 B. `(* (sin :rate 6) $tension)` = live-depth vibrato — the canonical interactive knob |
| `(+ G $pitch $x)` | `E_EVAL_NOT_LOWERABLE` (cumulative ADD unsafe under loop re-fire; later relaxation) |
| `$vel`/`$pitch` on a target that isn't theirs | `E_EVAL_NOT_LOWERABLE`, targeted message |

### 4.5 Slots as system registers (the round-2 keystone idea)

`def-val` slots are variables; the compiler may use them too:

- **Allocation**: user `def-val`s take slots 0.. in declaration order
  (unchanged, host-visible layout stable); compiler temporaries allocate
  from 15 downward. Overflow → `E_VAL_SLOTS_EXHAUSTED` with a usage listing.
  16 total is fixed (32 B RAM, driver.md §5) — left-fold lowering (§4.3)
  removes the need for temporaries in the common case, so pressure is low.
- **Reserve opcodes** (designed now, implemented when a real score needs a
  true temporary): `VAL_SET slot, imm16` (~25 B) and
  `VAL_ADD_VAL dst, src` (~20 B) stream ops. With them, non-left-linear
  shapes compile: evaluate one subtree into a temp slot, then run the main
  chain. (SUB_VAL ~15 B rides the same decision.)
- Temporaries are visible to the host via GET_VAL's direct array read —
  harmless; the metadata documents which slots are reserved.

### 4.6 Curve dyn params (legacy asymmetry — keep, fenced)

Bare `$refs` in curve `:from/:to/:rate/:len` keep v0.5 `dyn` behavior in the
live player (read at note-on) while MMB currently bakes slot init +
`W_MMB_DYN_SWEEP_BAKED` (export-mmb.js:704) or skips macros
(`W_MMB_MACRO_SKIPPED`, :265). The M3 dyn slice (§4.4) is the planned
closure of this gap — until it lands, the bake+warn behavior stands for
bare `$refs` only. The strict must-lower-or-error rule applies to **new
expression forms**; an *expression* (vs a bare `$ref`) in a dyn-able kwarg
is `E_EVAL_NOT_LOWERABLE`, so the lenient surface cannot grow.

## 5. Desugaring (Option B: suffixes are sugar)

One rule, four documented tiers: **`:param+ X` ≡ `:param (+ <base> X)`,
base = the parameter's current value at its natural tier** — compile shadow
for statically-known bases (now *all* params, §4.2); the note's velocity for
vel macros; the runtime shadow for hw params with runtime bases; the live
pitch offset for pitch/semi macros. All bases are nameable (`$vel`, `$oct`,
`$P`, `$pitch`), so the general expressions are writable without the sugar.

| Surface | Desugars to | Code that dies | Semantic change |
|---|---|---|---|
| inline `:oct+ X` / `:oct* X` | `:oct (+ $oct X)` / `(* $oct X)` | fold branch :2230-2243 | none |
| inline `:vel+ X` / `:vel* X` | `:vel (+ $vel X)` / `(* $vel X)` | fold branch :2289-2303 | none |
| hw `:P+ X` / `:P* X` | `:P (+ $P X)` / `(* $P X)` | RMW branch :2565-2573 | **works on all FM params now** (compile-shadow fold when static; RMW via generic read when runtime). `E_PARAM_NOT_READABLE` only for the stateless leftovers |
| hw `:P+ $x` / `:P* $x` | `:P (+ $P $x)` / `(* $P $x)` | :2558-2563 | same |
| macro `:vel+ spec` | `(macro :vel (+ spec $vel))` | `addMacroValues` + op plumbing (ir-player.js:413-428) | none (identical bake) |
| macro `:vel* spec` | `(macro :vel (* spec (/ $vel 15)))` | `scaleMacroValues` as a special case | none |
| macro `:pitch+` / `:semi+` | `(macro :pitch (+ spec $pitch))` | none (backend unchanged; `macroOpOk` :1018 stays for the sugar) | none |
| `:gate* R` / `:gate- T` | **not desugared — kept verbatim** | none | none. Articulation tokens (fraction-of-length / length-minus), not arithmetic on a base. language.md §7 stops listing them as operators; they move to §5 |
| echo/delay `:vel±*` + `:by` | **kept verbatim** (form and internals) | none in MVP | none. Zero corpus usage; the geometric tap series (`src·byᵏ`) is not a two-operand desugar. Rewire only when taps become expression-valued |

## 6. Diagnostics (new codes)

`E_EVAL_UNKNOWN_HEAD` (absorbs the `E_UNKNOWN_CURVE` catch-all role; keeps
curve-typo hinting) · `E_EVAL_OPERAND` · `E_EVAL_ARITY` · `E_EVAL_TYPE` ·
`E_EVAL_DIV_ZERO` · `E_EVAL_DEPTH` · `E_EVAL_NOT_LOWERABLE` ·
`E_PARAM_NOT_READABLE` (stateless targets only, post-§4.1) ·
`E_VAL_SLOTS_EXHAUSTED` · `E_SHADOW_LOOP_DIVERGENT` ·
`W_EVAL_CHAIN_LONG` · `E_EVAL_SIGNAL_{STEP,SHAPE,LEN,HOLD,NONAFFINE}` ·
`E_EVAL_UNIT_REQUIRED` · `E_NOTE_{RANGE,ARGS}` ·
`E_LET_{BINDING,NAME,SHADOWS_DEF}` · `E_DEF_RESERVED` · `E_DEFVAL_RESERVED` ·
`W_DEF_SHADOWS_BUILTIN`.

## 7. `let` semantics

- **Form-level only**: `(let ((name expr) …) body…)`. Legal in item position
  (body compiles in the extended env, spliced in place — sticky-state changes
  inside behave as if unwrapped) and value/expression position (body = one
  expression). No top-level `let` — file-level constants already work via
  `(def name 40)` token substitution, which composes with eval for free (the
  atom is substituted before the evaluator sees it; worth a doc callout).
- **Bindable**: scalars and signals. Streams → `E_LET_BINDING` (Phase 4).
- **Order**: sequential — each binding sees earlier ones (let* behavior).
- **Shadowing**: inner shadows outer. Names must fail all note-stream token
  predicates (`isNoteAtom` :1443, per-note-length :1471, rest :348, `v±`
  :1448, `o±` :1454, length grammar) → `E_LET_NAME`. Collision with
  defs/paramDefs → `E_LET_SHADOWS_DEF` (`expandNode` substitutes def tokens
  first; letting defs silently win would be a scoping lie).
- **Reference positions**: inside eval expressions (env lookup), and as a
  bare atom in value positions (checked before the literal parser — so
  `(let ((v 12)) :vel v c e)` works). Not in item position: a bare bound name
  in the note stream stays `E_UNKNOWN_ATOM` (quasiquote rule; splicing is
  `(note …)` / Phase 4 streams).
- **Phase 4 seam**: env chain + builtin registry are what def-function
  evaluation (call = env extension + body eval) and `for` (per-iteration env
  + stream concat) need. Nothing in the MVP shape needs revisiting.

## 8. Migration & compatibility

- **Corpus survey** (re-verified on 18abe79): `:gate*` ×6, `:vol*` ×4
  (m3-dynval), inline `:vel+` ×3 (m2-motion), `:tl4+` ×2, `:pitch+` ×1
  (demo1), macro `:vel±*` ×0 in hand-written scores (mucom importer emits
  them), echo/delay ×0. Every used surface is preserved verbatim; the
  compile shadow only *adds* working forms. Reserved-name checks hit no
  existing file. **Expected breakage: zero.** Gate: full-corpus compile + IR
  snapshot.
- **IR**: no shape changes in the MVP. ir.md gains a §6 note (step values may
  be float) and §11 updates as the readable set grows.
- **MMB**: additive flag exists (bit1); scaled flag = bit2 + a slot byte
  (descriptor has reserved flag bits, mmb.md §15); VAL_SET/VAL_ADD_VAL/CALL/
  RET take new opcode ids when implemented (opcodes.md amendment per step).
- **Docs** (at implementation time): language.md §7 → "Operators and
  expressions" (the one-rule desugar table, the `$`-reference table,
  type/lifting rules, the sampling-tier table, `let`, `note`,
  `ticks`/`frames`); the `:gate` family moves into §5; §8 gains the
  reserved-name rule, slot allocation, and the boundary rule; §11 gains
  "curves are library functions; arithmetic on them folds" and `:seed`.
- **Editor/formatter**: new heads in `mmlisp-formatter.js` /
  `mmlisp-syntax/` / live highlighting tables — mechanical. (The highlighter
  keyword list already misses several operator forms, live/index.html ~:2185
  — fix in the same pass.)

## 9. CALL/RET + encode-time dedup (data size; independent of eval)

Confirmed feasible; the driver side was pre-designed at the TCB freeze:

- **Driver**: the TCB control stack (4 × {ptr u16, count u8},
  driver.md §5) is shared between loops and calls — **"CALL entries are
  tagged count = 0xFF (M3)"** is already in the frozen layout. `d_call`
  (read u16 target, push {resume ptr, 0xFF}, jump — ~20-28 B) + `d_ret`
  (pop, tag-check, restore — ~15-22 B) + 2 dispatch entries (~10 B) =
  **~45-60 B resident** (neighbors measured: d_loop_begin 13 B,
  d_loop_end 38 B).
- **Key property**: a fragment is stored once at a fixed address and CALLed
  — never relocated — so absolute pointers *inside* a fragment are fine.
  Constraints: a fragment must end in RET (no fall-through, no outward
  JUMP), and combined loop+call nesting depth ≤ 4, checked per path by the
  exporter.
- **Exporter dedup pass**: event-boundary-aligned longest-repeat factoring
  (streams are KBs; simple scanning suffices), rewriting repeats as CALLs.
  Collapses `def` snippet expansions (today duplicated by token
  substitution), non-adjacent verse/chorus repeats (`(x N)` only compresses
  adjacent ones), and **cross-track phrase sharing** (streams are pointers
  into the same bank).
- **Perfect verification**: dedup is a pure encode transform — the same
  score with dedup on/off must produce byte-identical register traces;
  `verify:all` is the safety net as-is.
- Context: vs VGM/XGM (register-log formats, tens-to-hundreds of KB/min),
  MMB is already 1-2 orders smaller (gate scores: 1-1.8 KB incl. tables);
  dedup targets another ~20-40% on structured songs. Matters when the
  cartridge is shared with game assets.

## 10. Z80 budget — measured (baseline 2026-07-14, emulation; now tool-emitted)

Methodology is **permanent tooling** (step 6, DONE): `cd drv && npm run size`
(static size audit — assemble via `tools/build-driver.mjs`, sort code symbols,
gap-to-next = routine size) and `npm run budget` (size audit + the stack
watermark across the *full* gate corpus). The watermark is a min-SP hook in
`z80cpu.mjs push16`; every `verify.mjs` run also prints a `stack …` line.
STACK_FLOOR is now a named equ ($1FAE) so the 82 B window is explicit in the
source. Re-run after any driver change; these numbers are the tool output, not
hand-measured.

Baseline (`npm run budget`, **after step 7 eviction**): resident image
**5647 B**, ceiling G_PCMV **5882 B** ($16FA) → free **235 B**. Overlays
445/268/255/238/**250** (ovl_rare) B in a 451 B slot (slack 6 B). Stack: worst
case **40 B used of the 82 B window** (42 B reserve) on **m3-macro-keyon**
(the tramp_rare+load_overlay path peaks at 38 B, under the worst case).
Rare-event cold setup now **25 B** resident (d_marker only; the rest evicted).

Step-6 corrections vs the 2026-07-12 hand-measurement (surfaced by the tools;
drv/src was byte-identical, so stale figures not regressions): ceiling
5872→**5882** (build-driver's `$16F0` comment was 10 B stale), free 24→**34**,
worst stack 37→**40 B** on a score (m3-macro-keyon) the manual scan missed.
Step 7 then freed **201 B** (34→235) via the ovl_rare eviction.

| Cost item | B |
|---|---|
| generic shadow read (§4.1) | 35-55 |
| additive macro branch (pending) | 50-60 |
| scaled macro flag (§4.4) | 30-40 |
| CALL/RET (§9) | 45-60 |
| **near-term total** | **160-215** |
| VAL_SET + VAL_ADD_VAL (+SUB_VAL) reserve (§4.5) | ~45-60 |

| Funding source | B | Basis |
|---|---|---|
| **current headroom (post-eviction)** | **235** | `npm run size` (free) — already covers the near-term total |
| DATA_BASE bump (worst stack 40 B of 82; keep a hardware-interrupt reserve) | ~20-26 | `npm run budget` (reserve 42 B; confirm on hardware) — **not needed near-term** |
| psf_pitch/ps_psg_pitch commonization | ~5 | measured (smaller than the old 15-20 estimate) — **not needed near-term** |

The step-7 eviction alone (**201 B**, ovl_rare) over-funds the near-term total
(160-215 B), so the DATA_BASE bump (hardware-gated) and psf commonization
(marginal) are held in reserve, not spent. Overlay-load cost ≈ 9.5k cycles
(~16% of a frame) — acceptable at rare-event rate; d_marker stays resident
(no gate coverage + keeps markers hot if they prove frequent). Scaled-macro
per-frame mul is negligible vs the PCM soft-mix. Hardware bring-up re-validates
the stack numbers (existing plan).

**Reduction ladder** (if budget falls short, stop anywhere — each tier is
independently valuable): Tier A (0 B): all compile-time eval incl. compile
shadow → Tier B (+35-55 B): generic read + left-fold chains → Tier C
(+50-60 B): additive branch → Tier D (+30-40 B): scaled macro → CALL/RET
(+45-60 B, parallel track, data-size driven) → Tier E (demand-driven): VAL
ops.

Done (step 6): the SP watermark is a permanent `verify.mjs` report line and
`drv/tools/size-audit.mjs` + `budget.mjs` (`npm run size` / `npm run budget`)
keep this table live.

## 11. Open risks & found issues

1. **Stale comment vs code**: export-mmb.js:215 says NOTE_PITCH/NOTE_SEMI
   macros are "still dropped", but `internMacro` computes i16 + additive
   flags and `buildMacroTable` documents i16 blobs. Implementation step 2
   must include a compile-check that a `:pitch` macro actually reaches
   MACRO_TABLE.
2. **Hold-sentinel value collision**: `MACRO_TARGET_RANGE.NOTE_PITCH.min =
   -32768` (ir-utils.js:31) equals the i16 hold sentinel 0x8000 (likewise
   −128/0x80 for i8 targets whose range reaches it). Pre-existing latent
   bug, more reachable with arithmetic. Independent fix: clamp min to
   sentinel+1 at MMB lowering (1 line, corpus 0-diff).
3. **Signal region model under ⊕ is deliberately restricted** (equal step, no
   loop⊕one-shot, single release). loop⊕one-shot composition is the designed
   first relaxation and the prerequisite for *baked* AM; runtime AM is
   covered by the scaled-macro flag.
4. **Per-note `:vel` bake is per-note, not per-frame** — kept as a deferred
   `$vel` expression; loops with varying velocity intern one MMB macro per
   distinct velocity, as today. Docs note only.
5. **`$` namespace carries multiple tiers** (compile / tick / frame / slot).
   Reserved-name checks prevent collisions; the sampling-tier table (§4.0)
   is the documentation answer. A second sigil (`@vel`) was considered and
   rejected — more syntax for the same semantics.
6. **Compile-shadow semantics vs host writes**: folded relative ops are
   relative to the *score-visible* value; host SET_PARAM in between is
   invisible. Documented; the runtime form (`(+ $P X)`) is the explicit
   opt-in to host-relative behavior. (With §4.1 the runtime form works on
   all FM params, so the escape hatch is real.)
7. **Multi-write chains touch the register between steps** (§4.3) — same
   tick, microseconds apart; inaudible but BUSY-wait cost per write;
   `W_EVAL_CHAIN_LONG` past ~6 ops.
8. **`E_UNKNOWN_CURVE` retirement** in value positions: grep shows only
   compiler-internal uses + docs; keep the old code as an alias in the
   near-miss branch as a cheap hedge.
9. **Float determinism**: fold uses JS doubles incl. `Math.sin` — same
   exposure as today's `sampleCurveUnit`; unchanged, documented.
10. **Inline stochastic sweeps** already diverge live vs Z80 (curve ids 8-11
    → linear-ramp fallback, mmb.js:214; known M3 open). Unrelated to eval /
    `:seed`; recorded so the lowering decision isn't forgotten.
11. **Budget numbers are emulation-measured**; stack depth and cycle
    headroom get final confirmation at hardware bring-up (already the
    plan of record).

## 12. Implementation plan (later sessions; every step lands green on `verify:all` + full-corpus IR snapshot)

Compiler track (Tier A — no driver changes):

1. **Evaluator core** — **DONE** (mmlisp-eval.js). Scalar core: env chain
   (`makeEnv`), builtin registry (`+ - * / min max abs round floor`),
   `evalNode`/`evalScalarValue`, depth-32 guard, `isEvalHead`/
   `EVAL_BUILTIN_NAMES` exports. `compileChannelBody` gained `env` (threaded
   through the two x-loop recursions + top call). Hooked: the hw-param default
   case (`:tl1 (+ 20 10)` → PARAM_SET, `Math.round`, before parseCurveSpec —
   eval heads are disjoint from curve names so curve dispatch is untouched) and
   `param-set` values. `collectDefs` errors `E_DEF_RESERVED` on a def/paramDef
   named after a builtin. `$ref` in an eval expr → `E_EVAL_NOT_LOWERABLE`
   (value machine is step 8); bogus non-eval `()` head still → `E_UNKNOWN_CURVE`
   (curve-builtin generalization to `E_EVAL_UNKNOWN_HEAD` is step 2). Gate met:
   corpus IR+diagnostics byte-identical (A/B snapshot), verify:all 20/20
   0-mismatch, strict 6/6, eval unit tests pass.
2. **Curve builtins + affine folding + `:seed`** — **DONE**. The evaluator's
   value model is now scalar | signal; curve heads resolve to symbolic signals
   via `ctx.parseCurve` (delegating to parseCurveSpec — curves stay OUT of the
   eval module). `+ - * /` do affine scalar⊕signal (one signal, tracked as
   `coeff·sample + offset`, folded at the end via `ctx.foldSignal`); ≥2 signals
   → E_EVAL_NOT_LOWERABLE (materialization is step 5), scalar÷signal /
   min/max/abs/… on a signal → E_EVAL_SIGNAL_NONAFFINE. Wired at the hw-param
   site (scalar→PARAM_SET, signal→PARAM_SWEEP) and parseMacroSpec's `()` branch
   (signal→{type:"curve",…}, scalar→const steps) — both build a root-env ctx
   locally (no env threading; `let` is step 4). `:seed N` (u32, default 0xDEAD)
   on noise/pink/perlin/brown via memoized `getStochasticLuts` (ir-utils);
   compile-time only, Z80 cost 0. **Key gotcha found**: mmlisp2ir's
   `mapMacroValues` keys on `spec.type`, but parseCurveSpec output is type-less
   → added `foldCurveValues` (shape-detecting, mirrors the curve branch's
   `from??0`/`to??0`) as `ctx.foldSignal`. Gate met: `(+ (sin) 10)` byte-
   identical to the shifted literal (inline PARAM_SWEEP AND macro MACRO_TABLE
   LUT), seedless == 0xDEAD, seeded differs, pitch macro reaches MACRO_TABLE;
   corpus IR+diag+MMB byte-identical (A/B), verify:all 20/20, strict 6/6.
   **Deferred** (not gated): computed curve kwargs (`:from (- 0 40)`) — §3's
   "one added capability"; bare-`$ref` dyn kwargs unchanged.
3. **Compile shadow + operator desugar rewiring** — **NOT DONE; do as ONE
   piece, no sub-splitting** (user directive 2026-07: "分割はしないでほしい…
   step8のことは一旦忘れて、原則を守って実装できる範囲を全部やって"). The
   investigation found: the shadow's payoff (folding static hw relatives to
   PARAM_SET) is Z80-realizable, but the runtime/self-ref cases (`:ar1+` on a
   poisoned base) need the generic shadow read (was §12 step 8) — so the whole
   value machine (shadow + fold + left-fold lowering + generic read) is ONE
   realizable unit; implement it together, not fragmented. Governing rule
   (user): IR may change, but **never emit a form the Z80 driver can't run** —
   gate on verify:all, not IR byte-identity. Corpus poisoning note: m3-dynval's
   `:vol* 2.0` follows `:vol* $fac` (poisons VOL) so it stays PARAM_MUL even
   with folding — likely still byte-identical. `:P±`/`$P` desugar depends on the
   generic read; don't ship the 0-based RMW.
4. **`let`, `note`, `ticks`/`frames`** — **DONE**. mmlisp-eval.js gained the
   `let` special form (value position) + `evalLet` (item position, returns the
   extended env for the body walk), `evalLengthValue` (`(ticks/frames expr)`
   bridge), `lookupBound` (bare let-bound name in a value position), and split
   `isEvalHead` (value dispatch: arith+let) from `isReservedHead`
   (arith+let+note+ticks+frames → `E_DEF_RESERVED`). mmlisp2ir.js: item-position
   `let` (child env, body spliced in place via compileChannelBody recursion) and
   `(note expr [len])` (→ MIDI via `midiToNoteParts`, octave set-then-restored so
   it doesn't leak, then `emitNoteForTrack` → ties/glide/shuffle/PCM/macros
   identical to a literal note; `resolveLengthNode` for the optional length).
   `let` names must fail the note-stream predicates (`isNoteStreamToken` →
   `E_LET_NAME`, so single letters a–g are rejected) and not shadow a typedDef
   (`E_LET_SHADOWS_DEF`). ticks/frames + bare-name wired at `:len`, `:gate`
   (absolute), `:vel`, `:oct`, hw-param default, param-set, and note length.
   Gate met: corpus IR+diag+MMB byte-identical (A/B), verify:all 20/20, strict
   6/6, feature tests pass. **§2.4 amended (user decision 2026-07):** a bare
   eval expression in a length position is NOT `E_EVAL_UNIT_REQUIRED` — its
   numeric result is a **note denominator**, uniform with a literal number
   (`(note 60 (+ 2 2))` ≡ `(note 60 4)` ≡ quarter; `:len (* 2 4)` ≡ `:len 8`).
   `(ticks/frames …)` remain the explicit bridges for those units; a computed
   value is otherwise a denominator. `let` also reaches macro values now (env
   threaded through parseMacroSpec via the inline macro handler). **Deferred**
   (mechanical tail): ticks/frames at curve `:len` and macro `:step` (those
   parsers lack the eval ctx/env); bare-name at `:vol`/`:master`/`:tempo`.
5. **Signal⊕signal materialization** — **DONE (MVP)**. `G⊕G` under `+ - * /`
   samples both operands pointwise (mmlisp-eval.js `materializeSignals`, reusing
   ir-utils `sampleCurveUnit` with the export-mmb.js phase formulas) into a float
   `steps` signal. `affineCombine` gained `ctx`: it finalizes the accumulator's
   affine transform, then materializes. Region composition: one-shot⊕one-shot →
   one-shot (length = max, shorter extends with its final value); loop⊕loop →
   loop with lcm period (>255 → `E_EVAL_SIGNAL_LEN`); loop⊕one-shot →
   `E_EVAL_SIGNAL_SHAPE`. **MVP restrictions (each a specific error):** curve
   operands only (step-vector operand → `E_EVAL_SIGNAL_SHAPE`), frame-based `:len`
   required (tick → `E_EVAL_NOT_LOWERABLE`), no `:wait` (→ `E_EVAL_SIGNAL_HOLD`),
   frame `:step` (tick → `E_EVAL_SIGNAL_STEP`). The macro `:step` is threaded
   through parseMacroSpec → ctx.stepFrames (both macro callers pass it). Binding:
   macro position wraps a materialized signal as `{type:"steps"}`; the inline
   hw-param position rejects it (`E_EVAL_SIGNAL_SHAPE` — macro-only). export-mmb
   lowerMacro's steps path now rounds+clamps at the binding site (§2.2 — no-op for
   the integer step vectors the parser already clamps, quantizes materialized
   floats; holds pass through). Gate met: hand-computed samples match;
   `(+ (linear 0..10 :len 4f) (linear 0..20 :len 4f))` MMB blob == hand-written
   `[0 10 20 30]`; corpus IR+diag+MMB byte-identical (A/B), verify:all 20/20,
   strict 6/6. **Deferred**: step-vector operands + hold resolution, loop⊕one-shot
   (baked AM), tick-len/step (needs the M3 tempo slice), gcd-clock resampling.

Driver track (Tiers B-D + data; each step separately gated):

6. **Measurement infra** — **DONE**. `z80cpu.mjs` tracks min-SP in `push16`;
   `run-trace.mjs` returns `stackMin`; `verify.mjs` prints a `stack N B used /
   window · reserve` line every run. New `tools/size-audit.mjs` (`npm run size`
   — resident/ceiling/free, overlay slot, cold-setup gross, fattest spans) and
   `tools/budget.mjs` (`npm run budget` — size audit + worst-case stack over the
   full gate corpus). Source gained a `STACK_FLOOR` equ ($1FAE, zero bytes) so
   the 82 B stack window is explicit. Gate met: verify:all 20/20 0-diff;
   per-routine sizes reproduce §10 exactly (d_tempo_sweep 61, cold-setup gross
   167, overlays 445/268/255/238, resident 5848). **Surfaced 3 stale §10
   figures** (drv/src byte-identical, so doc errors not regressions): ceiling
   5872→5882 (free 24→34), worst stack 37→40 B on m3-macro-keyon — §10 updated.
7. **Budget prep** — **DONE (eviction only; over-funded, so the rest is held)**.
   New `src/ovl_rare.z80` (overlay index 4, 250 B) hosts the rarely-fired
   event-stream handlers TEMPO_SET/TEMPO_SWEEP, CSM_ON/OFF/RATE, FM3_MODE;
   resident `tramp_rare` (~12 B) saves the opcode+PC across `load_overlay` and
   `jp OVERLAY_SLOT`, the overlay re-dispatches on A, and each handler `jp
   d_next` (resident) unchanged. The 6 dispatch entries retarget to tramp_rare.
   **d_marker stays resident** — no gate score covers it, so its eviction
   couldn't be trace-verified (candidate once a marker gate exists). Freed
   **201 B** (resident 5848→5647; free 34→**235 B**), which alone covers the
   near-term total (160-215) — so psf commonization (~5 B, marginal) and the
   DATA_BASE bump (hardware-gated) are NOT spent. Gate met: verify:all 20/20
   0-diff; worst-case stack unchanged (40 B / 42 B reserve — tramp path peaks
   38 B); ovl_rare 250 B < 451 slot.
8. **Generic shadow read** (§4.1) + left-fold lowering in the compiler
   (§4.3) + JS players' read_param parity. Gate: new trace score exercising
   FROM_VAL/ADD/MUL chains on op params; m3-dynval unchanged.
9. **Additive macro Z80 branch** (held since round 1; now unblocked) —
   `G_MADD` scratch, add-no-store in `psf_pitch`/`ps_psg_pitch`,
   `apply_note_semi` loads `CHS_PITCH`. Gate: new trace score incl. the
   `(+ (sin) $detune)` composite.
10. **Scaled macro flag** (§4.4) — MMB bit2 + slot byte; stepper branch +
    mul. Gate: new trace score (`(* (sin) $depth)` with mid-score SET_VAL
    via the cmd sidecar).
11. **M3 dyn slice** (note-on tier) — slot-fed curve params at fire time
    (overlay-hosted per-note work, PCM precedent). Gate: dyn scores stop
    warning and trace-match live.
12. **CALL/RET + dedup** (§9) — driver handlers + exporter pass. Gate:
    dedup on/off trace byte-equality across the corpus; size report.
13. **Docs + formatter/syntax** per §8; VAL-op reserve (§4.5) only on
    demonstrated need.
