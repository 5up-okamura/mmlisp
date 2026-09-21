# language.md vs the implementation — what is left of the 2026-09-18 audit

A line-by-line audit (four agents, snippets compiled and run) compared
docs/language.md with the compiler, the editor preview and the MMB/driver
path. The judgment-free items were fixed the same day (commits d1d1d64,
be08c05, f8acf9e, b44dd32, a530b3c: gate 0 keeps time, stage macros, :wait Nf,
>255-step warnings, delay/prio timing, def-val, tempo last-writer, gates, head
expressions, shuffle, recursion diagnostic, pcm diagnostics, :vel/:oct/:tempo
values, macro value tokens, :leak, :rate/:phase, hex :seed, :break, let-bound
curves, doc facts and examples). What remains, with the question each needs:

## Needs the user's decision (the driver sounds different from the editor)

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
5. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
6. **`:hold`** (§11): unit undefined — it quantizes the LUT index, not steps.
7. **Note names vs defs** (§3): the doc says a def named like a note cannot be
   referenced; the code lets the def win. Error at def time?
8. **`(fm3 …)` notes beside fm3-N tracks**: no diagnostic.

## Decided and fixed

- **Abutting fm3-N notes re-attack** (2026-09-21/22). The driver always did;
  the EDITOR's key merge left no gap — a full-gate operator note's interval
  ended exactly where the next one began, `_fm3MaskAt` returned the same mask
  on both sides, and no `$28` write happened at all, so every consecutive pair
  of operator notes was silently a slur. Against §17's re-key rule, and the
  driver was right. Fixed by closing the previous interval for that operator
  `KEY_ORDER_EPS_SECS` before the new key-on — the same ordering margin the
  normal channels' deferred key-off uses, where the separation the chip needs
  comes from the write path's own cost, not from the margin. `m3-fm3op` and
  `m4-fm3op-pitch` each lost one A/B divergence; their baselines are the gate.

- **A `:keyon` macro's leading step is a no-op** (2026-09-21, user: "先頭の
  アタック意味ないでしょ"). The first sample lands in the note's own frame,
  where the note has just attacked, so re-attacking there is a write with
  nothing behind it. language.md §10 had said this all along ("The first
  sample at t = 0 … is a no-op") and ir-player did it; the DRIVER was the one
  diverging, on every channel. Fixed in `mmlispseq.c` and `drv-player.js` with
  a per-slot `fresh` flag (the sustain loop can return to cursor 0, so the
  cursor alone cannot say "first"). Gate: `m3-macro-keyon`'s fm4 track,
  `[1 1 1 1]` — 0-diff on `$28` between the two players.

## Decided, no change

- **Consecutive `:gate 0` notes do not re-attack** (2026-09-20, user). Every
  other FM note now does — a full-gate note keys off right before the next
  note-on, and only `~` suppresses it — but `:gate 0` is an explicit request to
  hold, and the hold's key-off belongs to the runtime (`triggerKeyOff` / host
  `KEY_OFF`), which is the whole point of the form. Measured: `:gate 0 c e g`
  writes `f0 f0 f0` and sounds one attack with the pitch moving — the same
  object as `c ~ e ~ g`, so it reads as a sticky legato passage. FM only: PSG
  re-asserts its attenuation on every note-on and re-attacks either way.
  Written into language.md §17.

## Judgment-free but larger

- ~~fm3-N glide / pitch macros do nothing (or hit CH3) on the driver~~ FIXED
  2026-09-21 (`m4-fm3op-pitch`, `m4-fm3op-keyon`): pitch AND `:keyon` are per
  operator in all three players — a retrigger re-keys that operator's mask bit
  alone. Still not verified on fm3-N tracks: LEVEL macros (`:vol`/`:vel`/op
  params) — the driver ignores them on op2-4 and applies them to the shared
  CH3 on op1; the editor's handling was not audited.
- def-val min/max on the driver: VAL_TABLE carries no range, so SGDK setVal
  clamps only to i16 (§8) — a format change.
- Nf in one track converted at another track's mid-song tempo change (§4).
- Tick-0 tempo written as an expression is not seen by the Nf prescan.
- Imports: a local def does not win over an import in another namespace
  (§9.2); nested import paths resolve from the folder root, `..` rejected.
- Voice-def values must be integer literals (a `(def lvl 40)` constant or an
  expression is dropped); E_LET_SHADOWS_DEF only for voice/macro defs.
- Computed float levels on the driver (suspected: integer tables).
