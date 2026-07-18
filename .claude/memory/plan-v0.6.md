# v0.6 — score removal, compile-time eval, import (approved design plan)

Status: **Phase 1 + Phase 2 landed; Phase 3 design settled (compiler + most
driver steps landed).** Approved 2026-07 as the v0.6 direction. Phase 1 (score
removal) shipped at 53a85b7; Phase 2 (`import`) shipped 2026-07-18. The Phase 3 (eval)
design session ran 2026-07-11 — the normative record is
[design-eval.md](design-eval.md); implementation follows its §11 steps in
separate implementation chats. roadmap.md has the compact public version;
this is the full working plan.

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

## Phase 2 — `import` (+ preset) (independent, no eval) — **DONE 2026-07-18**
`(import "path")` compile-time merges another file's defs into the importing
score, folded into IR (no runtime dependency). Settled decisions:
- **Model**: `collectDefs` recognizes `(import "path")` → `imports[]`;
  `resolveImports`/`resolveImportFile` (mmlisp2ir.js) recursively parse +
  collectDefs each imported file and merge the four def namespaces
  (defs/paramDefs/typedDefs/sampleDefs). `def-val` and tracks are **not**
  imported (`W_IMPORT_IGNORED`) — a slot index is the importer's host-visible
  layout; tracks are songs, not a library.
- **Collision**: imports are overridable defaults — local `def` **wins**
  silently; import-vs-import same-name = `E_IMPORT_CONFLICT` (origin-tracked, so
  diamonds dedup); cycle = `E_IMPORT_CYCLE`; missing = `E_IMPORT_NOT_FOUND`;
  non-string path = `E_IMPORT_PATH`.
- **Resolution**: `compileMMLisp` stays **synchronous/pure** — takes
  `options.imports` (Map path→text). The host (index.html) pre-resolves text
  async via the exported `collectImports(src)` (BFS through nested imports),
  reading through the source folder (like PCM `:file`) with a fetch fallback
  (server root). Path key = the literal string as written (flat-namespace
  limitation for nested relative paths — post-MVP refinement).
- **Verify**: node harness 14/14 (merge, local-wins byte-identity, conflict,
  cycle, not-found, ignored def-val/track, diamond); example
  `examples/source/import-demo.mmlisp` + `voices-lib.mmlisp` compile clean;
  `verify:all` green on feat/v0.6 (32 traces + ab-gate 33 scores — import is
  additive, driver unchanged); in-browser (Chromium) mmlisp2ir.js import path
  compiles the demo 0-error.
  **Caveat**: the full app-shell wiring (buildAction/hot-swap/load paths in
  index.html) could not be exercised end-to-end here — CodeMirror is CDN-loaded
  (esm.sh) and blocked in the cloud env, so the shell can't boot; the module
  script is syntax-validated and the resolver mirrors the working PCM pattern.
  Live-verify the folder/served import flow when next in the live app.
- **Editor/docs**: language.md §9.2 + §1 table; guide.md §7 import subsection;
  autocomplete lists `import`/eval heads/`:seed`/operator suffixes; the
  highlighter accents arithmetic call heads. roadmap Phase 2 → DONE.

Deferred to the fuller Future-Vision system (same `(import …)` surface):
`:from :stdlib`/`:patches`/URL, version pinning, per-path-relative nested
resolution, mucom `.dat` external voice-bank auto-import.

## Phase 3 — Compile-time eval (centerpiece) — **design settled**

**The design pass ran 2026-07-11; the full normative design record is
[design-eval.md](design-eval.md).** The five open questions and the operator
A/B question are decided:

1. **Escape syntax**: none — list-head dispatch; the evaluator hooks in-walk
   inside `compileChannelBody` (not the `expandRoots` pre-pass).
2. **Types**: scalar / signal (the existing spec objects, kept symbolic for
   LUT byte-identity; `scalar⊕signal` folds affinely) / stream (Phase 4;
   `(note n [len])` is the explicit scalar→note bridge). Length positions
   need explicit `(ticks …)`/`(frames …)`.
3. **Binding**: `let` (form-level, sequential) in MVP; def-function
   evaluation + `for` are Phase 4 — the env chain + builtin registry are the
   seam.
4. **Determinism**: eval pure; stochastic curves gain `:seed N` (default
   0xDEAD, memoized LUT regeneration; compile-time only, Z80 cost 0 B —
   retires the parked "seed-indexed LUT traversal" item).
5. **Boundary**: the unifying model is **sampling tiers** — a `$ref` is a
   variable; what differs is when it is read: compile (constant folding +
   the compile shadow over all params) / tick (opcode chains with the target
   param as accumulator — any left-linear expression over consts and
   `$slots` lowers with zero new opcodes, enabled by a generic shadow read
   derived from the existing `op_param_tab` write-descriptor table) /
   note-on (slot-fed curve params, the M3 dyn slice) / frame (additive +
   scaled macro flags). What cannot lower is a compile error; the legacy
   curve-`dyn` bake+warn path stays but is fenced.

**Operators: Option B** — `+`/`*` suffixes stay as pure desugaring
(`:P+ X` ≡ `:P (+ $P X)`; base = the parameter's current value at its
natural tier, nameable via built-in `$vel`/`$oct`/`$pitch`/self-ref `$tl1`…).
`:gate*`/`:gate-` are reclassified as articulation (kept verbatim); echo/
delay `:by` kept verbatim. The silent 0-base PARAM_ADD trap is **fixed
upward**: the generic shadow read makes all FM op params RMW-readable on the
Z80 (`:ar1+` works on hardware); `E_PARAM_NOT_READABLE` remains only for
genuinely stateless targets.

**Z80 budget is measured and funds the driver track** (design-eval.md §10):
costs 160-215 B (generic read, additive branch, scaled macro, CALL/RET) vs
funding ~165-205 B (headroom + rare-handler overlay eviction + DATA_BASE
bump sized by a measured 37/82 B stack watermark + commonization), with a
reduction ladder if it falls short. CALL/RET + an exporter dedup pass
(non-adjacent/cross-track phrase sharing) are confirmed feasible — the TCB
control stack already reserves the CALL tag. Corpus survey: zero expected
breakage.

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
Phase 1 first (concrete, non-breaking to IR, immediately shippable) — done.
Phase 2 (`import`) — done. **Phase 3 design is settled**
([design-eval.md](design-eval.md)); implementation follows its §11 ordered
steps (evaluator core → curve builtins → desugar rewiring → runtime lowering →
let/note/units → signal materialization → Z80 additive branch → docs), each
step gated on `verify:all` + full-corpus IR snapshots.
