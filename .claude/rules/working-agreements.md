# Working agreements

- **English** for all code, comments, and commit messages.
- **No AI attribution in git.** Do not add `Co-Authored-By: Claude` (or any
  AI tool) trailers, `Generated with` lines, or AI co-authors/committers to
  commits. Commits are authored solely by the human committer.
- **No legacy support.** v0.4-and-earlier behavior is not maintained; remove
  dead code that only served deprecated specs rather than guarding it.
- **Minimalism is about the output, not the tooling.** Every feature must
  justify its cost in language/IR complexity and eventual Z80 driver footprint.
  This constrains *what we expose and how it maps to hardware* — it is not a
  call to micro-optimize the JS toolchain.
- **Directness.** Keep the path from MMLisp expression to driver instruction as
  short as possible; prefer explicit, predictable behavior over implicit magic.
- This is a design-heavy, collaborative project. For non-trivial language or
  IR changes, confirm the design before implementing — the spec is decided
  through discussion, not inferred.
