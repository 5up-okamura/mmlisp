# Voice picker in the editor — shipped 2026-10-03

What it does is `docs/guide.md` §22 (Completions). This file keeps only the
reasons the guide does not, and what is still open.

## Why it has this shape

- **Not a modal panel — the existing completion, strengthened.** The list
  never takes typing (only ↑↓ / Enter / Esc), which is what makes the `@`
  trigger safe next to mucom's `@1` voice names.
- **Every preset set, imported or not.** The user chose this after asking
  about speed: 10 sets / 374 names / ~100 KB; a substring filter over 5,000
  names costs ~0.5 ms a keystroke; the list renders at most 12 rows. Set text
  only, through Browse's cache — a sample's WAV loads only when auditioned.
- **Audition on ↑↓, never on Space** — Space must stay a typed space. Only a
  keyed move sounds (a capture keydown timestamp, `noteCompletionNavKey`);
  opening or narrowing the list stays quiet.
- **Long-press rides `classifyToken`** (a `name` field), so long-press means
  "edit this" for every kind of token.
- **Words that read as music** (`a-`, `e8.`, `v-2`) never open the list on
  their own — substring + description matching made flats noisy.
- **Import judged by the written `(import …)` lines**, not `_importSources`:
  the latter is only re-read on Build, so after a new score it still holds the
  old score's sets.

## Open

- **PSG.** PSG has no voice def, but an envelope is a macro def
  (`(def env1 (macro :vel […]))`), which the scan already tags `macro`.
  Offering macro defs on `sqr…` / `noise` tracks — and a preset set of PSG
  envelopes — would make this work for PSG too; but macros are not PSG-only,
  so which ones to show is undecided. Today a PSG track gets no voices or
  samples, only the score's other names.
- A score's own `def-pcm` is not auditioned from the list: its `:file` is
  relative to the score's folder, which the preview's stand-in score lacks.
