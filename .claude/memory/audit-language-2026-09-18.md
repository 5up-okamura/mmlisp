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
5. **Consecutive `:gate 0` notes** re-key with no key-off between them (both
   players), so FM does not re-attack — intended?
6. **`:len 0` then more events** (§17): the IR/preview play them at the same
   tick; the driver waits for the host KEY_OFF.
7. **`:hold`** (§11): unit undefined — it quantizes the LUT index, not steps.
8. **Note names vs defs** (§3): the doc says a def named like a note cannot be
   referenced; the code lets the def win. Error at def time?
9. **`(fm3 …)` notes beside fm3-N tracks**: no diagnostic.

## Judgment-free but larger

- fm3-N glide / pitch macros do nothing (or hit CH3) on the driver: the macro
  engine and sweep banks cover channels 0–9 only (§15).
- def-val min/max on the driver: VAL_TABLE carries no range, so SGDK setVal
  clamps only to i16 (§8) — a format change.
- Nf in one track converted at another track's mid-song tempo change (§4).
- Tick-0 tempo written as an expression is not seen by the Nf prescan.
- Imports: a local def does not win over an import in another namespace
  (§9.2); nested import paths resolve from the folder root, `..` rejected.
- Voice-def values must be integer literals (a `(def lvl 40)` constant or an
  expression is dropped); E_LET_SHADOWS_DEF only for voice/macro defs.
- Computed float levels on the driver (suspected: integer tables).
