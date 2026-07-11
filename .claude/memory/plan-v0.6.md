# v0.6 — score removal, compile-time eval, import (approved design plan)

Status: **design stage.** Approved 2026-07 as the v0.6 direction. Phase 1 is
concrete and ready to implement; Phase 3 (eval) is the centerpiece and needs its
own design session before any code. Implementation happens in separate
implementation chats; this file is the design record to continue from.
roadmap.md has the compact public version; this is the full working plan.

## Context (the "why")

MMLisp is built to a realistic state (high-performance Z80 driver, expressive
live player). A design review concluded the S-expression foundation only earns
its keep if the compiler can **evaluate**. Without eval, `(fm1 c e g …)` is a
flat token stream that feels un-Lispy and forces ad-hoc operators (`:pitch+`,
`:vel±`, echo `:by`) — each a frozen special-case of arithmetic the language
can't otherwise express.

Unlocking reframe: the channel body is an implicit **quasiquote** — bare atoms
are literal note data; parenthesized forms are the compute ("unquote") boundary.
MMLisp's existing **atom-vs-list split already is that boundary**. So adding
**compile-time eval** (evaluable form heads whose results splice into the note
stream / directive values) is a natural extension that retroactively justifies
the Lisp foundation.

Constraints (locked):
- Runtime stays on the **Z80 with the current driver**. 68k-side compute is a
  last resort (steals game CPU), rejected as the primary path.
- **eval is COMPILE-TIME only**; output is **static data** (driver replays
  tables, unchanged — macro curves already bake this way).
- The **sole** runtime-varying escape hatch is `$slot`/`def-val`. Everything
  else is fair game to fold.
- Terse notation preserved; the note stream stays literal.

## Locked decisions
- **1 file = 1 score.** Remove the `(score …)` wrapper; the file *is* the score.
  Multi-score-for-reuse is replaced by `import`.
- No "score options" tier once `score` is gone:
  - **File metadata** `title`/`author` → reserved defs `(def title "…")` /
    `(def author "…")`.
  - **`:tempo` / `:lfo-rate`** — global, but **written on a track** (head/body);
    affect the whole song regardless of which track carries them. `:tempo` stays
    as-is (initial at tick 0 + mid-track). Both already work as track directives
    (mmlisp2ir.js: `:tempo` case ~2429; `:lfo-rate` target map ~1897).
  - **`:shuffle` / `:shuffle-base`** — per-track head options. The old
    score-wide `:shuffle` default is dropped.
- Ordering preserved by **source order**, not the wrapper; def/track forms
  interleave freely at top level (`E_DEF_IN_SCORE` dissolves).
- eval bakes to static data; `$slot` is the only runtime carrier.
- Notation stays terse: atom = literal note (quasiquote), list-form = evaluated
  or a known construct.

## Phase 1 — Remove `(score …)` (independent, ships first, no eval)
`collectDefs` already splits `{defs, paramDefs, typedDefs, sampleDefs, vals,
remaining}` from top-level roots in source order. Touch points (mmlisp2ir.js):
- Replace score discovery `roots.find(isAtom "score")` + `throw` (~3657-3663)
  with "the post-expand root list *is* the score body."
- **Delete** the score-option reading block (~3665-3693): `:tempo`/`:lfo-rate`
  and `:shuffle`/`:shuffle-base` already work on tracks; only `title`/`author`
  need a new home (reserved defs). Drop the score-wide `:shuffle` default.
- Repoint the two source-ordered passes over `score.items` (~3719 prescan,
  ~3750 build) at the root list.
- Invert the guard (~3754-3769): defs legal beside channel forms; only a
  genuinely-unknown top-level head errors (drop `E_DEF_IN_SCORE`).
- Migrate: example/test scores, mucom importer output (emits `(score …)`),
  editor templates + snippet, docs (§1, guide).
- Verify: all scores/importer/templates compile; `verify:all` 0-diff (pure
  front-end restructuring → same IR).

## Phase 2 — `import` (+ preset) (independent, no eval)
Compile-time merge of defs (voices/macros/snippets/samples) from another file or
preset, folded into IR (no runtime dependency). Simplest model: AST merge — run
`collectDefs` over merged roots; reuse the mucom `.dat` voice-bank load/merge
pattern. Decide path resolution + name-collision policy. This is the **core** of
the fuller Future-Vision `import` / patch system (`:from :stdlib`/`:patches`/URL,
version pinning) — same `(import …)` surface, built out later.

## Phase 3 — Compile-time eval (centerpiece; needs its own design pass)
Model: evaluable form heads (`let`/`if`/`for`/`+ - * /`/`note`/generators) run at
compile time; results splice into the note stream or resolve directive values.
Bare atoms stay literal (the atom/list split is the literal/compute boundary).

**Consolidates** (survey: all are the same "bake if static, else emit a runtime
op" done ad-hoc per feature):
- macro `:vel±`/`:vel*` — compile-baked (`scaleMacroValues`/`addMacroValues`,
  mmlisp2ir.js ~418-425) → general `(+ …)`/`(* …)` on signals, baked identically.
- echo/delay `:by` (`tapValue`, ~820) — compile taps → arithmetic over replays.
- macro curves already sample to **interned static LUTs** at MMB export
  (`internMacro`, export-mmb.js ~340-364) → curves become in-language library
  functions (`(def (sin …) …)`) baking to byte-identical LUTs (revives the
  original "curves in MMLisp" intent, Z80-viable because compile-time).
- `(+ (sin …) 10)`: a constant offset folds to a static LUT — exactly what
  `:pitch+` special-cased for lack of `+`.

**Leaves alone (stays runtime):** `$slot`/`def-val` — the sole host-mutable path
(`PARAM_FROM_VAL`/`ADD_VAL`/`MUL_VAL`; curve `dyn` params read once at note-on).
So `(+ (sin …) $detune)` keeps a `:pitch+`-style hook. `:pitch+` is not wasted —
it drew the compile/runtime line early; eval reclaims the compile-time side.

**Open design questions (settle before coding):**
1. Escape syntax: dedicated marker (`$(…)`, note the `$slot` overlap) vs
   list-head dispatch (a form whose head is an eval op evaluates).
2. Types: scalar / signal (curve) / stream (note sequence); how a computed
   number becomes a pitch (`(note 64)` / midi literal / relative to a root).
3. Binding & functions: `let`, and upgrading `(def (name args) body)` (today
   token-substitution) into an evaluating generator — the parametric def is the
   seed.
4. Determinism: stochastic curves use a fixed compile seed; keep eval
   reproducible.
5. Boundary discipline: only `$slot` survives to runtime; a computed value
   touching a `$slot` bakes to the slot init (current behavior + warning) or
   emits a runtime op.

### Operator consolidation — DISCUSSION MATERIAL (from the landed `:pitch+`)

Not settled — this is material for the eval design session. `:pitch+`/`:semi+`
already shipped (committed, docs synced) but are the **first instance** of the
operator→arithmetic consolidation, so their surface is up for redesign under eval.
(Folded here from the former standalone `:pitch+` plan, since removed — the
feature landed and its forward-relevant material lives here now.)

How the case splits:
- `:pitch+ X` = "add, per frame, to the channel's **live** pitch offset" (the
  offset set by inline `:pitch N`, which may be a `$slot` or a running sweep —
  read live).
- **Constant** `(+ (sin) 10)` → all operands static → folds to a LUT at compile
  time; no operator needed.
- **Runtime** `(+ (sin) $detune)` → one runtime operand → needs a per-frame add.

Landed runtime-add backend (reuse as the lowering target for `(+ signal runtime)`):
- MMB macro descriptor `flags` **bit1 = additive** (export-mmb.js `internMacro`);
  the intern key folds `flags`, so additive vs override intern separately.
- Drivers: on an additive descriptor, write `offset + macro_val` per frame
  **without** storing back (non-storing pitch variant). Z80: `G_MADD` scratch set
  from `bit 1,(iy+1)` in `sm_fire`; add + no-store branch in `psf_pitch` /
  `ps_psg_pitch`; `apply_note_semi` loads `CHS_PITCH` instead of 0. Cost ≈ +50-60 B
  resident code (fund by common-subroutining `psf_pitch`/`ps_psg_pitch` or a
  `DATA_BASE` bump); cycles/RAM trivial. Inline `:pitch+ N` is the opposite —
  sticky store — keep it separate.

Open surface question (to discuss): once arithmetic exists, do we
- **(A) eliminate the operators** — write `:pitch (+ (sin) detune)` explicitly.
  Uniform, but you must **name** the channel's live offset as a value.
- **(B) keep them as desugaring sugar** — `:pitch+ X` ≡ `:pitch (+ X <channel-
  pitch>)`. Keeps the ergonomic common case (shared vibrato + per-track detune)
  with one implementation (the arithmetic lowering); the special `:pitch+` code
  path dies but the surface lives.

Generalizes identically to `:vel±`/`:vel*`/`:tl±`. **Hinge:** both A and B need a
way to **reference a channel's current param/offset as a value in an expression**
(a built-in per-channel value, a `$slot` relative) — the key eval decision, tied
to open questions #2 (types) and #5 (compile/runtime boundary).

## Phase 4 — What eval enables (beyond consolidation)
Algorithmic composition (scales/arpeggios/euclidean via `for`/generators, baked
to static events); parametric phrases as real functions; signal composition
(`(+ (sin …) (saw …))`, `(* env lfo)` → layered/AM modulation baked to LUTs);
curves-as-a-standard-library.

## Verification
- Phase 1/2: all scores/importer/templates compile; `verify:all` 0-diff (no IR
  change).
- Phase 3: (a) curves-as-library produce byte-identical LUTs to builtins
  (MACRO_TABLE intern id matches) → gate 0-diff; (b) each consolidated operator
  (`:vel±`, echo `:by`, constant `(+ (sin) k)`) produces identical IR to the
  ad-hoc form it replaces; (c) `$slot` runtime paths unchanged.

## Sequencing
Phase 1 first (concrete, non-breaking to IR, immediately shippable). Phase 2 in
parallel or next. **Phase 3 (eval) needs a dedicated design session** to settle
the five open questions before any code — the v0.6 centerpiece, not a one-pass
change.
